# pi-split-view

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) TUI extension that
lays the main window out as one column: Messages on top, pi's editor below it, and two
collapsible drawers at the bottom of the screen, one for the model's thinking and one for
its tool calls.

```
 Think step by step about 17*23, then run one bash command.

 17 × 23 = 391, and the command printed hello-from-qa.

────────────────────────────────────────────────────────────────────────────
 >
────────────────────────────────────────────────────────────────────────────
 ~/project
 1.5%/1.0M (auto)                                   (anthropic) model • low
╭▸ Thinking (1 block · Turn 1/1) ──────────────────────────────────[↗][▸]╮
╭▾ Tool Usage (1 done · bash) ─────────────────────────────────────[↗][▾]╮
│ ▾ ✓ bash 0.0s echo hello-from-qa                                       │
│┃  $ echo hello-from-qa                                                 │
│┃  hello-from-qa                                                        │
│                                                                        │
╰─[◀] Turn 1/1 [▶]─[All]─────────────────────────────────────────────────╯
```

The Thinking drawer above is collapsed to its one-row bar; the Tool Usage drawer is open.

## Features

- **Drawers** — each drawer is a one-row bar when collapsed and a framed, scrollable
  panel when open. The bar shows a summary (block or line count, running and finished
  tools, the latest tool name) and a `●` while content streams. A drawer opens by itself
  on the first thinking block or tool call, unless you are scrolled up in Messages or
  have paged to an earlier turn. A drawer you open, close or resize by hand is pinned:
  it stays as you left it across turns. Drawers hide on terminals shorter than 12 rows.
- **Thinking drawer** — the live reasoning stream. The compact view
  (`/split-thinking-view`) draws one collapsible card per thinking block with a headline
  and preview; the full view draws continuous prose. A semantic HUD
  (`/split-thinking-hud`) colours paths, symbols, commands, numbers, pivots, risks and
  questions, locally or refined by a fast model. `/split-thinking-scope turn` keeps the
  current turn only. Scrolling away from the end holds the position while new reasoning
  streams in.
- **Tool Usage drawer** — one card per tool call with status, duration (a live elapsed
  counter while it runs) and an argument summary. An expanded card reuses pi's own tool
  rendering: syntax-highlighted code, coloured diffs, custom tool renderers and inline
  images. Click a card header to expand or collapse it; `/split-tools-expand` sets all
  cards at once. History is rebuilt from the session on resume, branch switch and
  compaction.
- **Live tool output** — while a tool that streams partial output runs (for example
  `bash`), a `[▶]` button appears at the right end of the open drawer's bottom frame. It
  pins the drawer to that tool's raw output stream (last 300 lines, tail-following). The
  pinned tool does not change on its own, and live mode stays on after the tool ends;
  `[◼]` leaves it. `/split-tools-live` picks among several streaming tools.
- **Turn pager** — Thinking and Tool Usage show the turns visible in Messages. The pager
  (`[◀] Turn 3/8 [▶] [All]`), on the collapsed Tool Usage bar and on the open drawer's
  bottom frame, steps through turns and scrolls Messages with it. `/split-turn` does the
  same from the keyboard.
- **Zoom** — `[↗]` on a drawer expands its panel over the whole area above the editor.
  A zoomed Tool Usage panel shows every card expanded.
- **Response-only Messages** — `/split-trim-response` swaps pi's transcript for a
  response-only view (user and assistant text, drawn with pi's own components) with a dim
  dashed rule between successive assistant answers (`/split-divider`). With
  `/split-response-source transcript` it draws pi's own transcript minus tool calls
  instead, so what other extensions draw there (markdown transformers, custom entries,
  custom messages) renders and takes clicks.
- **File tree pane** — a right column at full height shows the session's working
  directory as a tree, with the drawers view to its left. Folders list on first open;
  `.git` is left out, and `node_modules`, `target`, `.venv`, `__pycache__`, `dist` and
  `.next` open only on a click. Files and closed folders carry their git status letter
  and color and their `+N -N` line changes against HEAD. Rows follow the agent's tool
  calls (legend below): the folders above a touched file open at once and the pane
  scrolls to a running row that is off screen. A folder above a running or held row
  never closes. Other folders close only when the touched rows need the room, at most
  once every 2 seconds. Touched rows that still do not fit are counted in the header
  (`↑2 ↓1`). A click selects a file; the bottom border names it, and the next prompt
  tells the model which file is selected, without changing the prompt text. The pane
  hides when the terminal is narrower than 100 columns, and a zoomed drawer leaves it
  in place.
- **One layout layer** — the extension composes one layer around pi's own transcript and
  editor dock, which it reuses verbatim, so input is untouched. Panels cache their
  rendered rows, theme changes recompose, and the layout is in place before the first
  paint.

File tree row states:

| Row | Meaning |
| --- | --- |
| tool icon, name with a moving bright band | a tool call that names the row is running; it lasts from the call's start to its end, with the icon and color of the call's Tool Usage card |
| name in a steady blue | a `read`, `grep`, `find` or `ls` call touched the row in the last 12 seconds |
| name in a steady peach | an `edit` or `write` call touched the row in the last 12 seconds |
| name in a steady green | a `bash` call that ended in the last 12 seconds changed the file (its git status, line counts or modification time differ from before the call) |
| `✗`, name in the error color | the call that touched the row in the last 12 seconds failed |
| name in the warning, success, error or accent color; letter at the right | git status: modified (`M`, `T`), new (`A`, `?`), deleted or unmerged (`D`, `U`), renamed or copied (`R`, `C`) |
| dim name | ignored by git |

A search (`grep`, `find`, `ls`) marks the folder it searches; when it ends, `grep` and
`find` also mark up to 12 files they found. A search of the whole working directory
marks the root name in the header. A call on a file that has no row (a new file, a
missing file, a file in a pruned folder) marks the nearest folder above it that has
one, or the root name. A `bash`
call marks nothing while it runs. Calls on paths outside the working directory, and
tools with no path argument, are not shown.

The drawers and the file tree need pi's fullscreen mode (`"tuiMode": "fullscreen"` in settings, or
`--tui-mode fullscreen`).

## Mouse

| Where | Action |
| --- | --- |
| a collapsed drawer bar | open the drawer |
| `[▾]` or the title on an open drawer's top border | close the drawer |
| the rest of an open drawer's top border | drag to resize the drawer (5–30 rows); a click without a drag closes it |
| `[↗]` on a drawer | expand the panel over the whole area above the editor |
| `[↙]` or `[×]` in a zoomed panel's header | back to the drawers |
| `[◀]` / `[▶]` / `[All]` / `[Sync]` in the pager | previous turn / next turn / all turns / follow the turns visible in Messages |
| `[▶]` / `[◼]` on the open Tool Usage bottom frame | pin the drawer to the raw live output of the newest streaming tool / back to all tools |
| a tool card or thinking card header | expand or collapse the card |
| wheel over an open drawer (frame included) | scroll that drawer |
| a folder in the file tree | open or close the folder |
| a file in the file tree | select the file; a click on the selected file clears the selection |
| the file name in the file tree's bottom border | clear the selection |
| the file tree's left border | drag to resize the pane (24–80 columns) |
| wheel over the file tree | scroll the tree; it follows the agent again when the next tool call starts |

## Commands

| Command | Effect |
| --- | --- |
| `/split` | toggle the drawers view: off = bare pi layout, on = drawers with the saved drawer state |
| `/split-tree` | show or hide the file tree pane |
| `/split-thinking` | open or close the Thinking drawer |
| `/split-tools` | open or close the Tool Usage drawer |
| `/split-drawer <thinking\|tools>` | open or close the named drawer |
| `/split-thinking-scope [turn\|session]` | Thinking buffer: `session` = keep every turn (default), `turn` = current turn only, cleared on each new user message |
| `/split-thinking-view [compact\|full]` | Thinking view: collapsible one-line cards or continuous prose |
| `/split-thinking-hud [ai\|local\|off]` | Thinking semantic HUD: local highlighting plus fast-model refinement, local only, or plain text; no argument cycles |
| `/split-tools-view` | compact ↔ full tool detail (full expands every card) |
| `/split-tools-expand [all\|collapse\|auto]` | expand all tool cards, collapse all, or auto (running tools expanded); no argument cycles |
| `/split-tools-live [off]` | live output of a streaming tool: pins the newest one, or opens a picker when there is a choice; `off` returns to all tools |
| `/split-turn [prev\|next\|live\|all\|<N>]` | page Thinking and Tool Usage by turn; no argument reports the current turn |
| `/split-trim-response [on\|off]` | Messages: full transcript ↔ response-only view |
| `/split-response-source [messages\|transcript]` | response-only content: `messages` = user + assistant text (default), `transcript` = pi's transcript minus tool calls, with other extensions' rendering |
| `/split-divider [rule\|space]` | response-only separator between successive answers: `rule` = dim dashed line (default), `space` = blank line |
| `/split-save` | store the current options, drawer state and file tree state as startup defaults for new windows |

Start pi with `--no-split` to begin with the bare pi layout; `/split` then turns the
drawers and the file tree on.

Commands change the current window only, so concurrent windows do not overwrite each
other. Only `/split-save` writes the config file.

## Config

`/split-save` writes `~/.pi/agent/ui-panels.json`. Each key is optional; a missing or
wrongly typed value falls back to its default, and keys not listed here are ignored.

| Key | Values | Default |
| --- | --- | --- |
| `toolMode` | `"compact"` \| `"full"` | `"compact"` |
| `toolsScope` | `"visible"` \| `"turn"` \| `"all"` | `"visible"` |
| `trimResponse` | boolean | `false` |
| `responseSource` | `"messages"` \| `"transcript"` | `"messages"` |
| `answerDivider` | `"rule"` \| `"space"` | `"rule"` |
| `thinkingScope` | `"session"` \| `"turn"` | `"session"` |
| `thinkingMode` | `"compact"` \| `"full"` | `"compact"` |
| `thinkingHudMode` | `"ai"` \| `"local"` \| `"off"` | `"ai"` |
| `drawers` | `{ thinking: { open, height }, tools: { open, height } }` | closed; 10 and 14 rows |
| `tree` | `{ open, width }` | shown; 36 columns |

```json
{
  "toolMode": "full",
  "trimResponse": true,
  "drawers": {
    "thinking": { "open": false, "height": 10 },
    "tools": { "open": true, "height": 14 }
  },
  "tree": { "open": true, "width": 36 }
}
```

`height` is the open drawer's height in rows, frame included (5–30). Both drawers start
collapsed when a session starts; the saved heights apply from the start, and the saved
`open` state applies when `/split` turns the drawers on.

`tree.width` is the file tree pane's width in columns, frame included (24–80). The pane
gets narrower than that when the rest of the layout would drop below 76 columns.

## Install

The sources are plain TypeScript loaded by pi's extension discovery; there is no build
step.

```sh
# install as a pi package from this fork
pi install git:github.com/kylesnowschwartz/pi-split-view

# or from a local checkout
pi install /path/to/pi-split-view

# or load it once without installing
pi --tui-mode fullscreen -e /path/to/pi-split-view/split-view.ts
```

Not compatible with other extensions that replace pi's fullscreen layout root (for
example pi-stereo-view): only one of them can own the layout.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test unit tests for the pure helpers
```

To try a working copy without the installed package getting in the way:

```sh
pi --no-extensions -e /path/to/pi-split-view/split-view.ts
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Files

- `split-view.ts` — the extension: buffers, panel bodies and chrome, Messages, events,
  commands
- `layout-drawers.ts` — the drawers layout: drawer state, bars, geometry, drag-resize
- `layout-types.ts` — types shared by the two files above
- `layout-manager.ts` — single-layer layout ownership around pi's base root
- `filetree/` — the file tree pane: tree model, listing, git, tool-call activity, fold
  and scroll rules, rows and the pane component; `index.ts` is its one entry
- `ui-panels-config.ts` — validated startup-default config (`~/.pi/agent/ui-panels.json`)
- `thinking-hud.ts` — semantic highlighting of thinking text
- `tool-highlighter.ts` — syntax highlighting of tool commands, code and output
- `helpers.ts` — pure helpers (truncation, caps, durations, turn spans, drawer geometry)
- `test/` — unit tests for the helpers, the config, the HUD, the highlighter and the
  file tree

## Acknowledgements

The file tree's logic (tree model, path helpers, prune list, git status and numstat
parsing, listing, icon map) is adapted from
[data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree),
MIT, Copyright (c) 2026 Kurt Buhler. Its license notice is in
[filetree/LICENSE](filetree/LICENSE).

## License

[MIT](LICENSE)
