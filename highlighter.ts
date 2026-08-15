/// <reference path="./lib/fresh.d.ts" />
const editor = getEditor();

/**
 * Persistent Highlighter for Fresh
 *
 * Port of the VS Code extension "Persistent Highlighter"
 * (github.com/jsfaint/persistent-highlighter) to the Fresh editor.
 *
 * Highlights terms in buffers with persistent rules that survive restarts:
 *   - Add/remove/toggle highlights from the selected text or word under cursor
 *   - 25 built-in colors (auto-rotating) or any custom hex color
 *   - Match modes: whole word, substring, regex (ReDoS-guarded)
 *   - Case sensitivity per rule
 *   - Built-in annotation tags (TODO:, FIXME:, ...) with high-contrast colors
 *   - Jump to next/previous highlight; scrollbar markers show all matches
 *
 * Rules persist via editor.setGlobalState (per-plugin isolated, cross-session).
 * Decorations are editor.addOverlay entries in a dedicated namespace, which
 * the editor re-anchors on edits; after each edit we re-scan the buffer so
 * stale matches disappear and new ones appear.
 *
 * Performance guardrails (ported from the VS Code original):
 *   - per-rule regex budget: 10ms wall-clock / 10k matches max
 *   - nested-quantifier patterns rejected at compile time (ReDoS)
 *   - buffers larger than MAX_FILE_BYTES are skipped entirely
 */

// =============================================================================
// Constants
// =============================================================================

const NAMESPACE = "persistent-highlighter";
const SCROLL_NAMESPACE = "persistent-highlighter-scroll";
const STORAGE_KEY = "highlightTerms";

/** Buffers larger than this (bytes) are skipped: matching would stall the UI. */
const MAX_FILE_BYTES = 3 * 1024 * 1024;
/** Upper bound on matches produced by a single rule against one buffer. */
const MAX_REGEX_MATCHES = 10000;
/** Wall-clock budget for one rule's exec loop over one buffer (ms). */
const REGEX_BUDGET_MS = 10;
/** Debounce window for re-applying highlights after edits (ms). */
const REAPPLY_DEBOUNCE_MS = 250;
/** Cap on compiled regex cache entries (FIFO eviction). */
const REGEX_CACHE_SIZE = 100;
/** Words are [A-Za-z0-9]+; "_" deliberately excluded so `hello` matches inside `hello_world`. */
const WORD_BOUNDARY = "[A-Za-z0-9]";

const CUSTOM_COLOR_ID_OFFSET = 1000;
const DEFAULT_ANNOTATION_TAGS = [
  "TODO:", "FIXME:", "NOTE:", "BUG:", "HACK:", "WARN:",
  "WARNING:", "REVIEW:", "OPTIMIZE:", "XXX:", "DEPRECATED:",
];

/** 25 built-in colors (RGB triplets, from the VS Code original's palette). */
const COLOR_POOL: [number, number, number][] = [
  [255, 255, 0], [173, 216, 230], [144, 238, 144], [255, 182, 193], [218, 112, 214],
  [255, 160, 122], [240, 230, 140], [152, 251, 152], [255, 218, 185], [221, 160, 221],
  [255, 99, 71], [255, 165, 0], [255, 215, 0], [154, 205, 50], [0, 255, 127],
  [64, 224, 208], [0, 191, 255], [138, 43, 226], [255, 20, 147], [255, 105, 180],
  [199, 21, 133], [255, 127, 80], [255, 69, 0], [218, 165, 32], [107, 142, 35],
];

/** Annotation tag colors: [background, foreground]. Dark foreground keeps
 *  the tag legible on the saturated background. One per built-in tag. */
const ANNOTATION_COLORS: [number, number, number][][] = [
  [[255, 176, 0], [0, 0, 0]],     // TODO
  [[255, 82, 82], [0, 0, 0]],     // FIXME
  [[64, 196, 255], [0, 0, 0]],    // NOTE
  [[255, 112, 67], [0, 0, 0]],    // BUG
  [[206, 147, 216], [0, 0, 0]],   // HACK
  [[255, 202, 40], [0, 0, 0]],    // WARN
  [[240, 98, 146], [0, 0, 0]],    // WARNING
  [[129, 199, 132], [0, 0, 0]],   // REVIEW
  [[255, 138, 101], [0, 0, 0]],   // OPTIMIZE
  [[121, 134, 203], [0, 0, 0]],   // XXX
  [[224, 224, 224], [0, 0, 0]],   // DEPRECATED
];

/** 18 curated preset hex colors (kept for the custom-color command hint). */
const PRESET_COLORS: { hex: string; name: string }[] = [
  { hex: "#FF6B6B", name: "Coral" }, { hex: "#4ECDC4", name: "Turquoise" },
  { hex: "#45B7D1", name: "Sky Blue" }, { hex: "#96CEB4", name: "Mint" },
  { hex: "#FFEAA7", name: "Light Yellow" }, { hex: "#DDA0DD", name: "Plum" },
  { hex: "#98D8C8", name: "Seafoam" }, { hex: "#F7DC6F", name: "Golden" },
  { hex: "#BB8FCE", name: "Lavender" }, { hex: "#85C1E9", name: "Light Blue" },
  { hex: "#F8C471", name: "Apricot" }, { hex: "#82E0AA", name: "Light Green" },
  { hex: "#F1948A", name: "Salmon" }, { hex: "#D7BDE2", name: "Light Purple" },
  { hex: "#A9DFBF", name: "Pale Green" }, { hex: "#FAD7A0", name: "Peach" },
  { hex: "#AED6F1", name: "Pale Blue" }, { hex: "#F5B7B1", name: "Rose" },
];

// =============================================================================
// Types
// =============================================================================

type HighlightMatchMode = "wholeWord" | "substring" | "regex";
type HighlightScopeType = "global" | "file" | "language";

interface HighlightedTerm {
  id: string;
  text: string;
  colorId: number;
  enabled?: boolean;
  caseSensitive?: boolean;
  matchMode?: HighlightMatchMode;
  scopeType?: HighlightScopeType;
  scopeValue?: string;
  isCustomColor?: boolean;
  customColorHex?: string;
  isAnnotationTag?: boolean;
  annotationColorId?: number;
}

/** A single match: byte offsets into a buffer. */
interface MatchLocation {
  start: number;
  end: number;
  term: HighlightedTerm;
}

// =============================================================================
// Regex construction & cache (ported from the VS Code original)
// =============================================================================

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reject patterns that can backtrack exponentially (nested quantifiers or
 *  repeated alternation) — a single RegExp.exec cannot be interrupted, so
 *  these would freeze the editor. */
function isDangerousRegexPattern(pattern: string): boolean {
  return /\([^()]*[+*][^()]*\)[+*{]/.test(pattern)
    || /\([^()]*\|[^()]*\)[+*{]/.test(pattern);
}

function createHighlightRegex(
  searchText: string,
  caseSensitive: boolean,
  matchMode: HighlightMatchMode,
): RegExp {
  const flags = caseSensitive ? "g" : "gi";

  if (matchMode === "regex") {
    if (isDangerousRegexPattern(searchText)) {
      throw new Error(
        "Dangerous regex pattern (nested quantifier or repeated alternation); " +
        "it can freeze the editor. Please simplify the pattern.",
      );
    }
    return new RegExp(searchText, flags);
  }

  const escaped = escapeRegex(searchText);
  if (matchMode === "substring") {
    return new RegExp(escaped, flags);
  }

  // Whole-word: lookarounds keep the boundary out of the match. Underscore is
  // deliberately not a boundary character so `hello` matches inside
  // `hello_world`. Non-alphanumeric / CJK text falls back to plain matching:
  // languages without space-separated words have no usable word boundary.
  if (/^[a-zA-Z0-9]+$/.test(searchText)) {
    return new RegExp(
      String.raw`(?<!${WORD_BOUNDARY})${escaped}(?!${WORD_BOUNDARY})`,
      flags,
    );
  }
  return new RegExp(escaped, flags);
}

/** FIFO cache keyed by case:mode:text; reuse avoids recompiling per buffer. */
class RegexCache {
  private cache = new Map<string, RegExp>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(searchText: string, caseSensitive: boolean, matchMode: HighlightMatchMode): RegExp {
    const key = `${caseSensitive ? "s" : "i"}:${matchMode}:${searchText}`;
    let regex = this.cache.get(key);
    if (!regex) {
      regex = createHighlightRegex(searchText, caseSensitive, matchMode);
      if (this.cache.size >= this.maxSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) {
          this.cache.delete(oldest);
        }
      }
      this.cache.set(key, regex);
    }
    regex.lastIndex = 0;
    return regex;
  }

  clear(): void {
    this.cache.clear();
  }
}

const regexCache = new RegexCache(REGEX_CACHE_SIZE);

/** Run one rule against one buffer's text with safety budgets.
 *  Returns byte-offset matches; never throws (bad rules degrade to no match). */
function findMatchesInText(text: string, term: HighlightedTerm): MatchLocation[] {
  const locations: MatchLocation[] = [];
  let regex: RegExp;
  try {
    regex = regexCache.get(term.text, term.caseSensitive === true, term.matchMode ?? "wholeWord");
  } catch (err) {
    editor.warn(`highlighter: skipping rule "${term.text}": ${String(err)}`);
    return locations;
  }

  const maxMatches = Math.min(text.length + 1, MAX_REGEX_MATCHES);
  const startTime = Date.now();
  let match: RegExpExecArray | null;
  let count = 0;

  while ((match = regex.exec(text)) !== null) {
    count++;
    if (count > maxMatches) {
      break;
    }
    if (Date.now() - startTime > REGEX_BUDGET_MS) {
      editor.warn(`highlighter: rule "${term.text}" exceeded time budget; truncated`);
      break;
    }
    locations.push({ start: match.index, end: match.index + match[0].length, term });
    // Guard against zero-width matches looping forever.
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
      if (regex.lastIndex > text.length) {
        break;
      }
    }
  }
  return locations;
}

// =============================================================================
// Colors
// =============================================================================

/** "#RGB" or "#RRGGBB" → RGB triplet; null when malformed. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) {
    return null;
  }
  let h = m[1];
  if (h.length === 3) {
    h = h.split("").map((c) => c + c).join("");
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Background color for a term: annotation color, custom hex, or built-in pool. */
function termBgColor(term: HighlightedTerm): [number, number, number] {
  if (term.isAnnotationTag && term.annotationColorId !== undefined) {
    const idx = term.annotationColorId % ANNOTATION_COLORS.length;
    return ANNOTATION_COLORS[idx][0];
  }
  if (term.isCustomColor && term.customColorHex) {
    const rgb = hexToRgb(term.customColorHex);
    if (rgb) {
      return rgb;
    }
  }
  return COLOR_POOL[term.colorId % COLOR_POOL.length];
}

/** Foreground color for a term (annotation tags only), else null = default. */
function termFgColor(term: HighlightedTerm): [number, number, number] | null {
  if (term.isAnnotationTag && term.annotationColorId !== undefined) {
    const idx = term.annotationColorId % ANNOTATION_COLORS.length;
    return ANNOTATION_COLORS[idx][1];
  }
  return null;
}

function annotationColorIdForTag(tagText: string): number {
  const identity = tagText.trim().replace(/:$/, "").toUpperCase();
  return DEFAULT_ANNOTATION_TAGS.findIndex(
    (t) => t.replace(/:$/, "") === identity,
  );
}

// =============================================================================
// Rule persistence
// =============================================================================

function createHighlightId(text: string): string {
  return `highlight:${encodeURIComponent(text)}`;
}

function normalizeTerm(raw: unknown, defaultCaseSensitive: boolean): HighlightedTerm | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const t = raw as Record<string, unknown>;
  const text = typeof t.text === "string" ? t.text.trim() : "";
  if (text.length === 0) {
    return null;
  }
  const matchMode: HighlightMatchMode =
    t.matchMode === "substring" || t.matchMode === "regex" || t.matchMode === "wholeWord"
      ? t.matchMode
      : "wholeWord";
  const scopeType: HighlightScopeType =
    t.scopeType === "file" || t.scopeType === "language" ? t.scopeType : "global";
  const isAnnotationTag = t.isAnnotationTag === true;
  const annotationColorId = isAnnotationTag
    ? annotationColorIdForTag(text)
    : undefined;

  return {
    id: typeof t.id === "string" && t.id.length > 0 ? t.id : createHighlightId(text),
    text,
    colorId: typeof t.colorId === "number" ? t.colorId : 0,
    enabled: t.enabled !== false,
    // Built-in annotation tags always match case-sensitively and whole-word.
    caseSensitive: isAnnotationTag ? true : typeof t.caseSensitive === "boolean"
      ? t.caseSensitive
      : defaultCaseSensitive,
    matchMode: isAnnotationTag ? "wholeWord" : matchMode,
    scopeType,
    scopeValue: typeof t.scopeValue === "string" && t.scopeValue.length > 0
      ? t.scopeValue
      : undefined,
    isCustomColor: t.isCustomColor === true,
    customColorHex: typeof t.customColorHex === "string" ? t.customColorHex : undefined,
    isAnnotationTag,
    annotationColorId,
  };
}

function loadTerms(): HighlightedTerm[] {
  const raw = editor.getGlobalState(STORAGE_KEY);
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((t) => normalizeTerm(t, false))
    .filter((t): t is HighlightedTerm => t !== null);
}

function saveTerms(terms: HighlightedTerm[]): void {
  editor.setGlobalState(STORAGE_KEY, terms);
}

/** Merge the built-in annotation tags into the rule list so they render like
 *  ordinary rules and can be toggled per tag. */
function ensureAnnotationTags(terms: HighlightedTerm[]): HighlightedTerm[] {
  const changed = [...terms];
  let mutated = false;
  for (const tag of DEFAULT_ANNOTATION_TAGS) {
    const identity = tag.replace(/:$/, "");
    const existing = changed.some(
      (t) => t.isAnnotationTag && t.text.replace(/:$/, "").toUpperCase() === identity,
    );
    if (!existing) {
      changed.push({
        id: `annotation:${tag}`,
        text: tag,
        colorId: 0,
        enabled: true,
        caseSensitive: true,
        matchMode: "wholeWord",
        scopeType: "global",
        isAnnotationTag: true,
        annotationColorId: annotationColorIdForTag(tag),
      });
      mutated = true;
    }
  }
  return mutated ? changed : terms;
}

// =============================================================================
// Buffer matching & decoration
// =============================================================================

/** Per-buffer match cache, rebuilt on apply; used by jump-next/prev. */
const matchCache = new Map<number, MatchLocation[]>();
/** Buffers we already warned about (too large). */
const warnedBuffers = new Set<number>();

function termAppliesToBuffer(term: HighlightedTerm, bufferId: number): boolean {
  const info = editor.getBufferInfo(bufferId);
  if (!info) {
    return false;
  }
  switch (term.scopeType) {
    case "file":
      return term.scopeValue === info.path;
    case "language":
      return term.scopeValue === info.language;
    default:
      return true;
  }
}

/** Rebuild overlays + scrollbar markers for one buffer from all enabled rules.
 *  Skips virtual/terminal buffers and oversized files. */
async function applyToBuffer(bufferId: number): Promise<void> {
  const info = editor.getBufferInfo(bufferId);
  if (!info || info.is_virtual || info.is_terminal) {
    return;
  }
  if (info.length > MAX_FILE_BYTES) {
    if (!warnedBuffers.has(bufferId)) {
      warnedBuffers.add(bufferId);
      editor.setStatus(`Highlighter: ${info.name} is too large (${info.length} bytes); skipped`);
    }
    return;
  }
  warnedBuffers.delete(bufferId);

  // addOverlay appends instead of replacing, so rebuild from scratch:
  // clear the namespace first. Without this, removed rules keep their old
  // decorations on screen and every edit re-stacks duplicate overlays.
  // (setScrollbarMarkers replaces wholesale, but clearing first keeps the
  // two namespaces symmetric.)
  editor.clearNamespace(bufferId, NAMESPACE);
  editor.clearScrollbarMarkers(bufferId, SCROLL_NAMESPACE);

  const terms = loadTerms();
  const enabled = terms.filter((t) => t.enabled !== false && termAppliesToBuffer(t, bufferId));
  if (enabled.length === 0) {
    matchCache.delete(bufferId);
    return;
  }

  const text = await editor.getBufferText(bufferId);
  const all: MatchLocation[] = [];
  const markers: ScrollbarMarker[] = [];

  for (const term of enabled) {
    const locations = findMatchesInText(text, term);
    for (const loc of locations) {
      editor.addOverlay(bufferId, NAMESPACE, loc.start, loc.end, {
        bg: termBgColor(term),
        fg: termFgColor(term) ?? undefined,
      });
      all.push(loc);
      markers.push({ position: loc.start, color: termBgColor(term) });
    }
  }

  all.sort((a, b) => a.start - b.start);
  matchCache.set(bufferId, all);
  editor.setScrollbarMarkers(bufferId, SCROLL_NAMESPACE, markers);
  editor.debug(`highlighter: applied ${all.length} matches (${enabled.length} rules) to ${info.name}`);
}

async function reapplyAll(): Promise<void> {
  const buffers = editor.listBuffers();
  for (const b of buffers) {
    await applyToBuffer(b.id);
  }
}

/** Debounced re-apply after edits: merge rapid keystrokes into one pass. */
let pendingReapplyBuffer = -1;
let pendingReapplyTimer: number | null = null;

function scheduleReapply(bufferId: number): void {
  pendingReapplyBuffer = bufferId;
  if (pendingReapplyTimer !== null) {
    editor.clearInterval(pendingReapplyTimer);
  }
  pendingReapplyTimer = editor.setTimeout(REAPPLY_DEBOUNCE_MS, "highlighterFlushReapply");
}

// Editor setTimeout only accepts a global function name.
function highlighterFlushReapply(): void {
  pendingReapplyTimer = null;
  if (pendingReapplyBuffer < 0) {
    return;
  }
  const bufferId = pendingReapplyBuffer;
  pendingReapplyBuffer = -1;
  applyToBuffer(bufferId).catch((err) => editor.error(`highlighter: ${String(err)}`));
}

// =============================================================================
// Selection & word-under-cursor helpers
// =============================================================================

/** Text to highlight: explicit selection first, else the word under cursor. */
async function getTargetText(): Promise<string | null> {
  const bufferId = editor.getActiveBufferId();
  if (!bufferId) {
    editor.setStatus("Highlighter: no active buffer");
    return null;
  }
  const cursor = editor.getPrimaryCursor();
  if (!cursor) {
    return null;
  }
  if (cursor.selection && cursor.selection.end > cursor.selection.start) {
    return (await editor.getBufferText(bufferId, cursor.selection.start, cursor.selection.end)).trim();
  }
  return wordAtCursor(bufferId, cursor.position);
}

/** Extract the [A-Za-z0-9_]+ word containing `pos` by reading a window around
 *  the cursor. Returns null on whitespace/punctuation or buffer edges. */
async function wordAtCursor(bufferId: number, pos: number): Promise<string | null> {
  const WINDOW = 512;
  const start = Math.max(0, pos - WINDOW);
  const text = await editor.getBufferText(bufferId, start, pos + WINDOW);
  const re = /[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const wordStart = start + m.index;
    const wordEnd = wordStart + m[0].length;
    if (pos >= wordStart && pos < wordEnd) {
      return m[0];
    }
    if (pos === wordEnd && wordEnd === start + text.length && pos < start + WINDOW) {
      // Word runs past the read window's right edge; widen and retry once.
      const extra = await editor.getBufferText(bufferId, pos, pos + WINDOW);
      const head = /^[A-Za-z0-9_]+/.exec(extra);
      return head ? m[0] + head[0] : m[0];
    }
  }
  return null;
}

// =============================================================================
// Command handlers
// =============================================================================

function highlighterAdd(): void {
  getTargetText()
    .then((text) => {
      if (!text) {
        editor.setStatus("Highlighter: nothing selected and no word under cursor");
        return;
      }
      const terms = loadTerms();
      if (terms.some((t) => sameTerm(t.text, text, t.caseSensitive === true))) {
        editor.setStatus(`Highlighter: "${text}" is already highlighted`);
        return;
      }
      const colorId = terms.length % COLOR_POOL.length;
      terms.push({
        id: createHighlightId(text),
        text,
        colorId,
        enabled: true,
        caseSensitive: false,
        matchMode: "wholeWord",
        scopeType: "global",
      });
      saveTerms(terms);
      editor.setStatus(`Highlighted "${text}" (color ${colorId})`);
      reapplyAll().catch((err) => editor.error(`highlighter: ${String(err)}`));
    })
    .catch((err) => editor.error(`highlighter: ${String(err)}`));
}

function highlighterAddCustomColor(): void {
  (async () => {
    const text = await getTargetText();
    if (!text) {
      editor.setStatus("Highlighter: nothing selected and no word under cursor");
      return;
    }
    const hint = PRESET_COLORS.map((p) => `${p.name}=${p.hex}`).join("  ");
    const answer = await editor.prompt(`Hex color for "${text}" — ${hint}`, "#FF6B6B");
    if (answer === null) {
      return;
    }
    const rgb = hexToRgb(answer);
    if (!rgb) {
      editor.setStatus(`Highlighter: "${answer}" is not a valid hex color`);
      return;
    }
    const terms = loadTerms();
    if (terms.some((t) => sameTerm(t.text, text, t.caseSensitive === true))) {
      editor.setStatus(`Highlighter: "${text}" is already highlighted`);
      return;
    }
    terms.push({
      id: createHighlightId(text),
      text,
      colorId: CUSTOM_COLOR_ID_OFFSET,
      enabled: true,
      caseSensitive: false,
      matchMode: "wholeWord",
      scopeType: "global",
      isCustomColor: true,
      customColorHex: answer.trim().replace(/^#?/, "#"),
    });
    saveTerms(terms);
    editor.setStatus(`Highlighted "${text}" with ${rgb.join(",")}`);
    reapplyAll().catch((err) => editor.error(`highlighter: ${String(err)}`));
  })().catch((err) => editor.error(`highlighter: ${String(err)}`));
}

function highlighterRemove(): void {
  getTargetText()
    .then((text) => {
      if (!text) {
        editor.setStatus("Highlighter: nothing selected and no word under cursor");
        return;
      }
      const terms = loadTerms();
      const idx = terms.findIndex((t) => sameTerm(t.text, text, t.caseSensitive === true));
      if (idx === -1) {
        editor.setStatus(`Highlighter: "${text}" is not currently highlighted`);
        return;
      }
      terms.splice(idx, 1);
      saveTerms(terms);
      editor.setStatus(`Removed highlight "${text}"`);
      reapplyAll().catch((err) => editor.error(`highlighter: ${String(err)}`));
    })
    .catch((err) => editor.error(`highlighter: ${String(err)}`));
}

function highlighterToggle(): void {
  getTargetText()
    .then((text) => {
      if (!text) {
        editor.setStatus("Highlighter: nothing selected and no word under cursor");
        return;
      }
      const terms = loadTerms();
      const idx = terms.findIndex((t) => sameTerm(t.text, text, t.caseSensitive === true));
      if (idx === -1) {
        const colorId = terms.length % COLOR_POOL.length;
        terms.push({
          id: createHighlightId(text),
          text,
          colorId,
          enabled: true,
          caseSensitive: false,
          matchMode: "wholeWord",
          scopeType: "global",
        });
        editor.setStatus(`Highlighted "${text}"`);
      } else {
        terms.splice(idx, 1);
        editor.setStatus(`Removed highlight "${text}"`);
      }
      saveTerms(terms);
      reapplyAll().catch((err) => editor.error(`highlighter: ${String(err)}`));
    })
    .catch((err) => editor.error(`highlighter: ${String(err)}`));
}

function highlighterClearAll(): void {
  saveTerms([]);
  for (const b of editor.listBuffers()) {
    editor.clearNamespace(b.id, NAMESPACE);
    editor.clearScrollbarMarkers(b.id, SCROLL_NAMESPACE);
  }
  matchCache.clear();
  editor.setStatus("Highlighter: cleared all highlights");
}

/** Toggle a built-in annotation tag (TODO:, FIXME:, ...) on/off. */
function highlighterToggleAnnotationTag(): void {
  (async () => {
    const answer = await editor.prompt(
      "Toggle annotation tag (e.g. TODO:, FIXME:, NOTE:, ...)",
      "TODO:",
    );
    if (answer === null) {
      return;
    }
    const identity = answer.trim().replace(/:$/, "").toUpperCase();
    const tag = DEFAULT_ANNOTATION_TAGS.find(
      (t) => t.replace(/:$/, "") === identity,
    );
    if (!tag) {
      editor.setStatus(`Highlighter: "${answer}" is not a built-in annotation tag`);
      return;
    }
    const terms = loadTerms();
    const idx = terms.findIndex(
      (t) => t.isAnnotationTag && t.text.replace(/:$/, "").toUpperCase() === identity,
    );
    if (idx === -1) {
      editor.setStatus(`Highlighter: annotation tag "${tag}" not found`);
      return;
    }
    terms[idx].enabled = terms[idx].enabled !== true;
    saveTerms(terms);
    editor.setStatus(`Annotation tag ${tag} ${terms[idx].enabled ? "enabled" : "disabled"}`);
    reapplyAll().catch((err) => editor.error(`highlighter: ${String(err)}`));
  })().catch((err) => editor.error(`highlighter: ${String(err)}`));
}

/** Jump to the next (dir=1) or previous (dir=-1) match in the active buffer,
 *  wrapping around at the ends. */
function jump(dir: 1 | -1): void {
  const bufferId = editor.getActiveBufferId();
  if (!bufferId) {
    editor.setStatus("Highlighter: no active buffer");
    return;
  }
  let locations = matchCache.get(bufferId);
  if (!locations) {
    // Cache miss (e.g. buffer opened before this plugin ran): compute inline.
    applyToBuffer(bufferId)
      .then(() => {
        const after = matchCache.get(bufferId);
        if (!after || after.length === 0) {
          editor.setStatus("Highlighter: no highlights in this buffer");
          return;
        }
        jump(dir);
      })
      .catch((err) => editor.error(`highlighter: ${String(err)}`));
    return;
  }
  if (locations.length === 0) {
    editor.setStatus("Highlighter: no highlights in this buffer");
    return;
  }
  const cursor = editor.getPrimaryCursor();
  const pos = cursor ? cursor.position : 0;
  let next: MatchLocation | null = null;
  if (dir === 1) {
    next = locations.find((l) => l.start > pos) ?? locations[0];
  } else {
    const reversed = [...locations].reverse();
    next = reversed.find((l) => l.start < pos) ?? locations[locations.length - 1];
  }
  if (next) {
    editor.setBufferCursor(bufferId, next.start);
    const idx = locations.indexOf(next) + 1;
    editor.setStatus(`Highlighter: ${idx}/${locations.length} — "${next.term.text}"`);
  }
}

function highlighterJumpNext(): void {
  jump(1);
}

function highlighterJumpPrev(): void {
  jump(-1);
}

// =============================================================================
// Shared helpers
// =============================================================================

/** Case-insensitive text equality without Intl (unavailable in QuickJS). */
function sameTerm(a: string, b: string, caseSensitive: boolean): boolean {
  return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
}

// =============================================================================
// Events
// =============================================================================

function onBufferOpened(args: { buffer_id: number }): void {
  applyToBuffer(args.buffer_id).catch((err) => editor.error(`highlighter: ${String(err)}`));
}

function onBufferClosed(args: { buffer_id: number }): void {
  matchCache.delete(args.buffer_id);
  warnedBuffers.delete(args.buffer_id);
}

function onTextEdited(args: { buffer_id: number }): void {
  // Overlays re-anchor on edits automatically, but a match whose text changed
  // (or a new match that appeared) needs a re-scan. Debounced.
  scheduleReapply(args.buffer_id);
}

// =============================================================================
// Init
// =============================================================================

// Rules can be stale/missing after an upgrade; normalize + merge annotation
// tags once at load.
{
  const terms = ensureAnnotationTags(loadTerms());
  saveTerms(terms);
}

registerHandler("highlighterAdd", highlighterAdd);
registerHandler("highlighterAddCustomColor", highlighterAddCustomColor);
registerHandler("highlighterRemove", highlighterRemove);
registerHandler("highlighterToggle", highlighterToggle);
registerHandler("highlighterClearAll", highlighterClearAll);
registerHandler("highlighterToggleAnnotationTag", highlighterToggleAnnotationTag);
registerHandler("highlighterJumpNext", highlighterJumpNext);
registerHandler("highlighterJumpPrev", highlighterJumpPrev);
registerHandler("highlighterFlushReapply", highlighterFlushReapply);

editor.registerCommand("persistent-highlighter.add", "Highlighter: Add Highlight", "highlighterAdd");
editor.registerCommand("persistent-highlighter.addCustomColor", "Highlighter: Add Highlight with Custom Color…", "highlighterAddCustomColor");
editor.registerCommand("persistent-highlighter.remove", "Highlighter: Remove Highlight", "highlighterRemove");
editor.registerCommand("persistent-highlighter.toggle", "Highlighter: Toggle Highlight", "highlighterToggle");
editor.registerCommand("persistent-highlighter.clearAll", "Highlighter: Clear All Highlights", "highlighterClearAll");
editor.registerCommand("persistent-highlighter.toggleAnnotationTag", "Highlighter: Toggle Annotation Tag…", "highlighterToggleAnnotationTag");
editor.registerCommand("persistent-highlighter.jumpNext", "Highlighter: Jump to Next Highlight", "highlighterJumpNext");
editor.registerCommand("persistent-highlighter.jumpPrev", "Highlighter: Jump to Previous Highlight", "highlighterJumpPrev");

editor.on("after_file_open", onBufferOpened);
editor.on("buffer_activated", onBufferOpened);
editor.on("buffer_closed", onBufferClosed);
editor.on("after_insert", onTextEdited);
editor.on("after_delete", onTextEdited);
editor.on("after_file_revert", onBufferOpened);

// Decorate buffers already open when the plugin loads.
reapplyAll().catch((err) => editor.error(`highlighter: ${String(err)}`));
