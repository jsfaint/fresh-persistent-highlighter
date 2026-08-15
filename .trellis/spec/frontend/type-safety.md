# Type Safety

> TypeScript conventions in this project.

---

## Overview

`tsconfig.json` runs `"strict": true`, `"noEmit": true` (type-check only), ES2020, and
`"types": []` — no DOM, no Node libs. The only ambient types come from the plugin API
via `/// <reference path="./lib/fresh.d.ts" />` at the top of `highlighter.ts`. There is no
`any` anywhere in the codebase; keep it that way.

## Type Shapes

- **`interface` for object shapes** (`HighlightedTerm`, `MatchLocation`), **`type` for
  string-literal unions** (`HighlightMatchMode = "wholeWord" | "substring" | "regex"`).
  Both are declared in the Types section of `highlighter.ts`, with JSDoc noting semantics
  (e.g. "A single match: byte offsets into a buffer").
- **`undefined` for absent optional fields, `null` for "no result".**
  `HighlightedTerm` uses optional props (`customColorHex?: string`); functions that can
  fail return `| null` (`hexToRgb(hex): [number, number, number] | null`).
- **Tuple types for fixed-size color triplets**: `[number, number, number]` for RGB
  everywhere (never a loose `number[]`).

## Validating Untrusted Data

Storage payloads and event args arrive as `unknown`. The codebase pattern
(`normalizeTerm` in `highlighter.ts`):

1. Narrow with `typeof` checks and fall back to a default for every field:
   ```ts
   const matchMode: HighlightMatchMode =
     t.matchMode === "substring" || t.matchMode === "regex" || t.matchMode === "wholeWord"
       ? t.matchMode
       : "wholeWord";
   ```
2. Reject invalid entries entirely (`null`), and drop them downstream with a type
   predicate filter:
   ```ts
   .filter((t): t is HighlightedTerm => t !== null)
   ```
3. The only cast in the file is the deliberate `raw as Record<string, unknown>` at the
   entry point — never cast deeper into the object.

## Runtime Constraints (documented in code)

- **No `Intl`** — the QuickJS runtime lacks it; `sameTerm` does case folding with
  `toLowerCase()` and a comment explaining why.
- **No DOM APIs** — regexes are built with `String.raw` templates (see
  `createHighlightRegex`); lookbehind is available in the runtime, so whole-word
  matching uses `(?<!...)`/`(?!...)` boundaries.
- Regexes are **reused, never rebuilt per call** — `RegexCache.get(...)` also resets
  `lastIndex` before returning a cached `RegExp` (stale `lastIndex` is a classic bug
  with global-flag regexes).

## Avoid

- ❌ `any`, `as unknown as X`, or casting past the top-level record — storage/event
  shapes change; validation must be field-by-field.
- ❌ Partial object literals typed as full interfaces — build complete terms
  (see `ensureAnnotationTags`) or `normalizeTerm` will silently reset missing fields.
- ❌ `number[]` where a fixed-size tuple fits, `string | null` where an optional
  property fits, and bare `RegExp` reuse without resetting `lastIndex`.
- ❌ Adding DOM/Node libs to `tsconfig` to make something compile — the plugin runs in
  a sandbox that doesn't have them.
