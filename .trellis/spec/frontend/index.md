# Frontend Development Guidelines

> Coding conventions for this repository — a single-file plugin for the Fresh editor.

---

## Context

`persistent-highlighter` is **not a web frontend**. It is a TypeScript plugin for the Fresh
terminal editor: one `highlighter.ts` in global scope (no module system), talking to the editor
through the ambient API in `lib/fresh.d.ts`. These guidelines describe how that code is
actually written — before adding code, also read
[`directory-structure.md`](./directory-structure.md) for the file layout and the
`// ====` section order inside `highlighter.ts`.

---

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Directory Structure](./directory-structure.md) | Single-file plugin layout, what lives where, section banners |
| [Component Guidelines](./component-guidelines.md) | Function conventions, the command-handler pattern, registration |
| [Hook Guidelines](./hook-guidelines.md) | Event handlers, async chains / IIFEs, named timers, debounce |
| [State Management](./state-management.md) | Persistent rules vs transient caches, normalization on load |
| [Type Safety](./type-safety.md) | Strict TS, unions/interfaces, validating `unknown` payloads |
| [Quality Guidelines](./quality-guidelines.md) | `tsc` verification, feedback prefixes, performance budgets |

---

**Language**: All documentation is written in **English**.
