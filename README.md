# Persistent Highlighter

Persistent text highlighting for the [Fresh](https://github.com/sinelaw/fresh) editor — a port of the VS Code extension [Persistent Highlighter](https://github.com/jsfaint/persistent-highlighter).

Highlights terms in buffers with **persistent rules that survive restarts**, in multiple colors, with whole-word / substring / regex matching and built-in annotation tags (TODO:, FIXME:, …).

## Features

- **Persistent rules**: stored via `setGlobalState`, restored on every start
- **Add / remove / toggle** highlights from the selected text or the word under the cursor
- **25 built-in colors** (auto-rotating) or **any custom hex color**
- **Match modes**: whole word (with smart boundaries — `hello` matches inside `hello_world`), substring, regex
- **Case sensitivity** per rule (annotation tags always case-sensitive)
- **Annotation tags**: TODO:, FIXME:, NOTE:, BUG:, HACK:, WARN:, WARNING:, REVIEW:, OPTIMIZE:, XXX:, DEPRECATED: — high-contrast colors, toggleable
- **Jump to next / previous highlight** (wraps around)
- **Scrollbar markers**: every match is painted on the vertical scrollbar
- **Performance guardrails**: per-rule time budget, ReDoS pattern rejection, oversized files skipped

## Installation

### Via the package manager

```sh
pkg: Install from URL   # then enter this repository's URL
```

### Manually

Copy `highlighter.ts` (and the `lib/` directory for type checking) into your Fresh plugins directory, then restart Fresh.

### Quick development loop

Open `highlighter.ts` in Fresh and run **Load Plugin from Buffer** from the command palette — the plugin activates with LSP support for the plugin API, so edits hot-reload as you type.

## Usage

All commands live in the command palette (`Ctrl+P`):

| Command | What it does |
|---|---|
| `Highlighter: Add Highlight` | Highlights the selection, or the word under the cursor |
| `Highlighter: Add Highlight with Custom Color…` | Same, but asks for a hex color (`#RRGGBB`) |
| `Highlighter: Remove Highlight` | Removes the rule matching the selection / word under cursor |
| `Highlighter: Toggle Highlight` | Adds or removes the rule |
| `Highlighter: Clear All Highlights` | Removes every rule and decoration |
| `Highlighter: Toggle Annotation Tag…` | Enables / disables one built-in tag (e.g. `TODO:`) |
| `Highlighter: Jump to Next Highlight` | Moves the cursor to the next match |
| `Highlighter: Jump to Previous Highlight` | Moves the cursor to the previous match |

You can bind these to keys in your Fresh config, e.g.:

```json
{
  "keyBindings": {
    "alt+h": "command:persistent-highlighter.toggle",
    "alt+n": "command:persistent-highlighter.jumpNext",
    "alt+p": "command:persistent-highlighter.jumpPrev"
  }
}
```

## How it works

- Rules are a JSON list of `HighlightedTerm` persisted with `setGlobalState` (per-plugin isolated, cross-session).
- Decorations are `addOverlay` entries in the `persistent-highlighter` namespace. Overlays are re-anchored by the editor on edits; after each edit the plugin re-scans the buffer (debounced 250 ms) so stale matches disappear and new ones appear.
- Matching reuses the VS Code original's algorithm: lookaround word boundaries for pure-alphanumeric terms, plain matching for CJK / punctuation-heavy text.
- Buffers over 3 MB are skipped (with a status-bar notice) to keep the editor responsive.

## Development

```sh
# Type-check the plugin (single-file, like the official plugins)
npx -p typescript tsc --noEmit --strict --target esnext --module esnext \
  --moduleResolution bundler --lib esnext,dom --skipLibCheck \
  --allowImportingTsExtensions --ignoreConfig --ignoreDeprecations 6.0 highlighter.ts
```

## Limitations vs. the VS Code original

- No sidebar tree view (management panel) — planned for a later version
- No workspace-wide match search (`rg`)
- No per-rule scope control UI (the data model keeps `scopeType`, but the commands always create global rules)
- Terminal colors are opaque RGB; the VS Code original's translucency has no terminal equivalent

## License

MIT
