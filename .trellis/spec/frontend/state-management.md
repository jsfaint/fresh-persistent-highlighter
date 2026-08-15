# State Management

> Where plugin state lives, how it persists, and how it is validated.

---

## Overview

No state library. Two kinds of state exist, with strict separation:

1. **Persistent rules** — user highlight terms, stored via the editor's global state API.
2. **Transient module state** — caches and pending-work flags, plain module-level
   variables in `highlighter.ts`.

## Persistent State (rules)

- **One storage key** (`STORAGE_KEY = "highlightTerms"`), written through a single
  save function:
  ```ts
  function loadTerms(): HighlightedTerm[] { ... editor.getGlobalState(STORAGE_KEY) ... }
  function saveTerms(terms: HighlightedTerm[]): void { editor.setGlobalState(STORAGE_KEY, terms); }
  ```
  Storage is per-plugin and survives restarts — never store buffers or decoration
  geometry there, only the rules.
- **Load is a normalization boundary.** Storage content is untrusted `unknown`, so
  `normalizeTerm(raw: unknown, ...)` validates every field with `typeof` checks and
  falls back to defaults; invalid entries are dropped (`loadTerms` filters with a
  type predicate). See `type-safety.md`.
- **Migrate at load, then save.** The Init section runs a one-time
  `ensureAnnotationTags(loadTerms())` → `saveTerms(...)` so rules that are stale or
  missing after an upgrade get repaired.
- **Write policy:** mutate a *copy* (`const changed = [...terms]`), and only save when
  something actually changed — `ensureAnnotationTags` returns the original array
  unchanged when nothing was added, avoiding pointless writes.

## Transient Module State

| State | Type | Lifecycle |
|-------|------|-----------|
| `matchCache` | `Map<number, MatchLocation[]>` | Per-buffer match list for jump-next/prev; rebuilt on apply, deleted on buffer close / clear-all. |
| `warnedBuffers` | `Set<number>` | One-time "file too large" warnings; deleted on close, cleared on success. |
| `regexCache` | `RegexCache` (FIFO `Map`) | Compiled regex reuse, capped at `REGEX_CACHE_SIZE` with FIFO eviction. |
| `pendingReapplyBuffer` / `pendingReapplyTimer` | `number` / `number \| null` | Debounce bookkeeping, reset by the flush callback. |

Rules for module state:

- Declare it near the section that uses it, with a `/** */` comment explaining the
  lifecycle (`highlighter.ts`, "Buffer matching & decoration" section).
- **Every entry point that invalidates the state must clean it up** — `onBufferClosed`
  deletes from `matchCache` and `warnedBuffers`; `highlighterClearAll` clears `matchCache`.
- Keep caches bounded (`REGEX_CACHE_SIZE`, FIFO eviction) — unbounded caches leak in a
  long-lived editor process.

## Avoid

- ❌ Writing to storage on every edit/keystroke — edits only *schedule* a debounced
  re-apply; storage changes only in command handlers.
- ❌ Storing derived data (match positions, decorations) in global state — they are
  rebuilt from rules on demand.
- ❌ Duplicate module-level mirrors of persisted rules; `loadTerms()` is the single
  source of truth for the current rule list.
- ❌ Calling `loadTerms()` in a loop (e.g. per match) — load once per operation.
