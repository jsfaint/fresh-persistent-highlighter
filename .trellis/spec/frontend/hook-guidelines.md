# Hook Guidelines

> Event wiring, async flows, and callback patterns.

---

## Overview

No React hooks exist here. The "hook" analogs in a Fresh plugin are **event handlers**,
**named callbacks**, and **async flows**. All patterns below come from `highlighter.ts`.

## Event Handlers

- Event handler functions are named `on<Event>` (`onBufferOpened`, `onBufferClosed`,
  `onTextEdited` in `highlighter.ts`) and receive a typed payload, e.g. `{ buffer_id: number }`.
- Subscriptions are grouped in the Init section at the bottom:

  ```ts
  editor.on("after_file_open", onBufferOpened);
  editor.on("buffer_activated", onBufferOpened);
  editor.on("after_insert", onTextEdited);
  ```
- One handler can be subscribed to several events (reuse `onBufferOpened`).
- Event handlers are thin: they delegate to `applyToBuffer` / `scheduleReapply` and
  never do storage or matching inline.
- Handlers that do async work must end with a `.catch()` that reports via
  `editor.error("highlighter: ...")` — no unhandled rejections.

## Async Patterns

Two accepted shapes, both ending in `.catch((err) => editor.error(...))`:

1. **Promise chain** for a single async fetch followed by sync work:
   ```ts
   function highlighterAdd(): void {
     getTargetText().then((text) => { ... }).catch((err) => editor.error(...));
   }
   ```
2. **Async IIFE** when several `await`s interleave with user prompts:
   ```ts
   function highlighterAddCustomColor(): void {
     (async () => { const text = await getTargetText(); ... })()
       .catch((err) => editor.error(...));
   }
   ```

No top-level `await`; command handlers are `void` functions that kick off the chain.

## Named Callbacks and Timers

`editor.setTimeout` / `editor.setInterval` accept a **global function name string**, not a
closure:

```ts
// Editor setTimeout only accepts a global function name.
function highlighterFlushReapply(): void { ... }
// ...
pendingReapplyTimer = editor.setTimeout(REAPPLY_DEBOUNCE_MS, "highlighterFlushReapply");
```

The debounce pattern (`highlighter.ts`, `scheduleReapply`): keep one pending-id variable and one
timer variable; cancel the previous timer before scheduling a new one; the flush callback
reads the pending id and resets both.

## Avoid

- ❌ Anonymous closures passed to `registerHandler`, `editor.on`, or `editor.setTimeout`
  — they cannot be referenced by name and the timer API cannot call them at all.
- ❌ `.then()` without a terminal `.catch()` — an error becomes a silent no-op.
- ❌ Duplicating the debounce/timer machinery; reuse `scheduleReapply` or extract a
  shared helper before writing a second copy.
- ❌ Awaiting inside `registerHandler` functions — handlers are invoked synchronously
  by the host; return `void` and use the IIFE pattern.
