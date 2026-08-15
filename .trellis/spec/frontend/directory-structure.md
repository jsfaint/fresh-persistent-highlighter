# Directory Structure

> How code is organized in this project.

---

## Overview

This is **not a web frontend**. `persistent-highlighter` is a single-file plugin for the Fresh editor
(a terminal editor with a QuickJS-based TypeScript plugin runtime). Plugins run in a global
scope: there is **no module system** — no `import`/`export`, no bundler, no `node_modules`
at runtime. The whole plugin must be one `.ts` file.

---

## Directory Layout

```
persistent-highlighter/
├── highlighter.ts   # The entire plugin (currently ~830 lines)
├── lib/
│   └── fresh.d.ts    # AUTO-GENERATED plugin API types — never edit
├── package.json      # Manifest: "type": "plugin", fresh.entry, min_api_version
├── tsconfig.json     # strict TypeScript, noEmit (type-check only)
└── README.md         # Human docs: features, commands, install
```

## What Lives Where

| Path | Role |
|------|------|
| `highlighter.ts` | All plugin code: constants, types, logic, handlers, registration. The only file a developer edits. |
| `lib/fresh.d.ts` | `getEditor()`, `EditorAPI`, `registerHandler`, global event types. Header says **"AUTO-GENERATED FILE - DO NOT EDIT MANUALLY"** — never modify it; regenerate from the Fresh source. |
| `package.json` | `"fresh": { "entry": "highlighter.ts", "min_api_version": 1 }` — the `entry` field names the plugin file; keep the two in sync when renaming. |

## Section Organization Inside `highlighter.ts`

`highlighter.ts` is ordered by `// ====` banner sections. New code goes into the matching existing
section; a genuinely new concern gets its own banner between the existing ones. Current order:

1. Constants
2. Types
3. Regex construction & cache
4. Colors
5. Rule persistence
6. Buffer matching & decoration
7. Selection & word-under-cursor helpers
8. Command handlers
9. Shared helpers
10. Events
11. Init (registration + initial re-apply, at the very bottom)

Banner style:

```ts
// =============================================================================
// Rule persistence
// =============================================================================
```

## Naming Conventions

- File names: lowercase kebab / plain (`highlighter.ts`, `fresh.d.ts`).
- Plugin-global functions get the `highlighter` prefix (`highlighterAdd`,
  `highlighterToggleAnnotationTag`, `highlighterFlushReapply`) — the plugin shares one global
  scope, so the prefix prevents collisions with other plugins or built-ins.
- Every function that must be addressable by name at runtime (command handler, event handler,
  timer callback) is a **named top-level function declaration** — see `component-guidelines.md`.

## Anti-patterns

- ❌ Adding a second `.ts` file or using `import` — the runtime cannot load it.
- ❌ Editing `lib/fresh.d.ts` — generated file, changes get overwritten and can desync from the real API.
- ❌ Renaming the entry file without updating `package.json`'s `fresh.entry` — the manifest must name the real file.
- ❌ Adding `export`/`import` statements or `export default` — there is no consumer.
