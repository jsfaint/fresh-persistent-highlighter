# Component Guidelines

> How plugin code units are shaped in this project.

---

## Overview

This project has no UI components (no React/Vue/DOM). The "component" analog in a Fresh
plugin is the **named top-level function** plus the **section** it belongs to. All of the
patterns below are evidenced in `highlighter.ts`.

## Function Conventions

- **Named function declarations, never arrow-const expressions, for anything addressable
  at runtime.** The plugin API references functions by *name string*: `registerHandler(...)`,
  `editor.on(...)`, `editor.setTimeout` all take a handler name. `highlighter.ts:const editor` is the
  only top-level `const` holding a value from the API.
  ```ts
  function highlighterAdd(): void { ... }        // ✔ named declaration
  const highlighterAdd = () => { ... };          // ✘ breaks registerHandler by name
  ```
- **JSDoc on every function**, explaining *why* the function behaves that way, not what it
  does mechanically. See `wordAtCursor` (`highlighter.ts`) documenting the window-read + widen-retry
  rationale, or `isDangerousRegexPattern` explaining the ReDoS freeze risk.
- **Single responsibility + a `Shared helpers` section** for logic used by several handlers
  (`sameTerm`, `hexToRgb`, `termBgColor`, `getTargetText` live there, `highlighter.ts`).

## The Command Handler Pattern

Every user command is a thin handler with the same 5 steps:

1. Load terms from storage (`loadTerms()`).
2. Validate the input (`getTargetText()` + dedupe via `sameTerm`).
3. Mutate a *copy* of the term list.
4. Persist (`saveTerms(terms)`).
5. Re-apply highlights (`reapplyAll()`) and report via `editor.setStatus`.

Reference: `highlighterAdd`, `highlighterRemove`, `highlighterToggle` in `highlighter.ts`.

Handlers never `return` user data; they report through `editor.setStatus("Highlighter: ...")`
and errors through `editor.error("highlighter: ...")` (see `quality-guidelines.md`).

## Handler Registration

Registration happens in the Init section at the bottom, in two steps:

```ts
registerHandler("highlighterAdd", highlighterAdd);
editor.registerCommand("persistent-highlighter.add", "Highlighter: Add Highlight", "highlighterAdd");
```

- Handler name: camelCase of the function name.
- Command id: `persistent-highlighter.<kebab-action>`; human title: `"Highlighter: <Title>"`.
- Command ids are the public contract (keybindings, palette) — never rename without
  keeping the old one working.

## Avoid

- ❌ Inline object literals with only some fields — terms always have the full
  `HighlightedTerm` shape (build via `normalizeTerm`-compatible literals, as in
  `ensureAnnotationTags`).
- ❌ Copy-pasting the load → dedupe → push → save sequence into a new command; reuse
  `loadTerms`/`saveTerms` and keep the diff minimal (extract a helper when a third
  command needs it).
- ❌ Functions that mix UI feedback with core logic — matching/decoration functions
  (`findMatchesInText`, `applyToBuffer`) never touch the status bar themselves; the
  caller reports.
