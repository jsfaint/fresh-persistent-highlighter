# Quality Guidelines

> Standards, verification, and performance guardrails.

---

## Overview

No test suite and no linter config exist in the repo. Quality is enforced by strict
type-checking, the Fresh plugin API's typed surface, and the performance guardrails
documented below. The development loop is hot-reload: open `highlighter.ts` in Fresh and run
**Load Plugin from Buffer** (see `README.md`).

## Verification

```sh
npx tsc --noEmit   # strict type-check; must pass before committing
```

That is the only CI-able check. Manual verification happens in Fresh: load the plugin,
exercise every command in `README.md`'s table, restart Fresh and confirm rules survived.

## User Feedback Conventions

Every user-visible message uses one of the editor's reporting APIs, with a fixed prefix:

| API | Purpose | Prefix example |
|-----|---------|----------------|
| `editor.setStatus` | Command results / notices | `"Highlighter: added \"foo\" (color 2)"` |
| `editor.warn` | Recoverable problems (skipped rule, budget exceeded) | `"highlighter: rule ... exceeded time budget; truncated"` |
| `editor.error` | Async failures (always paired with `.catch`) | `"highlighter: <error>"` |

Success messages start with `Highlighter:`, diagnostics with `highlighter:` (lowercase).
All messages are user-facing English, one line, and state what happened.

## Defensive Degradation Over Throwing

- User-supplied regexes are **validated at compile time** — `isDangerousRegexPattern`
  rejects nested quantifiers / repeated alternation with a clear error before
  `new RegExp` runs, because a single `RegExp.exec` cannot be interrupted.
- Everything after that **never throws**: `findMatchesInText` wraps regex construction
  in try/catch, warns, and returns no matches; bad rules degrade to invisible, never to
  a crash.
- API-level failures (`getBufferText` rejection, etc.) are caught at the handler
  boundary and reported via `editor.error`.

## Performance Guardrails

The plugin runs matching synchronously on the editor's main thread, so every path has a
budget (constants in `highlighter.ts`):

| Guardrail | Constant | Rationale |
|-----------|----------|-----------|
| Buffer size cap | `MAX_FILE_BYTES = 3 MiB` | Larger buffers are skipped entirely (warned once per buffer via `warnedBuffers`). |
| Match cap per rule | `MAX_REGEX_MATCHES = 10 000` | Bound overlay count and memory. |
| Wall-clock budget per rule | `REGEX_BUDGET_MS = 10 ms` | `Date.now()` checked inside the exec loop; truncated with a warning. |
| Zero-width match guard | inline in `findMatchesInText` | Global regexes can loop forever on zero-width matches; `lastIndex` is bumped and the loop bounded. |
| Regex cache | `REGEX_CACHE_SIZE = 100`, FIFO | Reuse compiled regexes; evict oldest. |
| Re-apply debounce | `REAPPLY_DEBOUNCE_MS = 250 ms` | Merge rapid keystrokes into one re-scan. |

**Rule of thumb:** any new matching/decoration loop must be bounded by a constant from
this table (or a new documented one) — unbounded loops over user text freeze the editor.

## Decoration Lifecycle (overlay rebuild)

- `editor.addOverlay` **appends**: each call adds a new decoration; it never replaces or
dedupes. The only way to remove decorations is `editor.clearNamespace` (or
`clearAllOverlays` / `clearOverlaysInRange`).
- `applyToBuffer` therefore always rebuilds from scratch — `clearNamespace` +
`clearScrollbarMarkers` first, then re-add every match for the current rules. Skipping
the clear leaves stale decorations on screen after a rule is removed, which read as
"remove is broken" while `clearAll` (which clears directly) still worked.
- `setScrollbarMarkers` replaces the namespace wholesale, so markers don't accumulate;
clearing them first anyway keeps the two namespaces symmetric.
- Never add overlays without clearing the same namespace earlier in the same rebuild
function — overlays accumulate invisibly on every debounced re-scan after edits.

## Formatting / Style Baseline

Style follows what `highlighter.ts` does today (no formatter config): 2-space indent, single
quotes, semicolons, trailing commas in multiline literals, `String.raw` for regex
templates. Long `editor.registerCommand(...)` lines are acceptable as-is — do not
reformat existing code.

## Avoid

- ❌ `console.log`/`alert` — plugins report through the editor API, never the console.
- ❌ Throwing from matching/decoration paths — degrade with `editor.warn` instead.
- ❌ Unbounded loops, caches, or regexes against user text — always apply the budgets above.
- ❌ Silent failures — every user action ends in `setStatus`, `warn`, or `error`; a
  command that does nothing visible is a bug.
