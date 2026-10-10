# Claude Code GUI

A Cursor-style desktop app for Claude Code. Instead of reading a terminal, you get a
three-pane workspace: file explorer on the left, editor in the middle, and a chat
transcript on the right that renders Claude's tool calls — file edits as diffs, shell
commands with their output, searches with their patterns.

It does not reimplement Claude. The app drives the real `claude` CLI that is already
installed on your machine, in `--print` + `stream-json` mode, and renders the event
stream it produces.

## Requirements

- macOS (window chrome uses the native inset title bar)
- Node 22+
- Claude Code CLI on `PATH`, authenticated (`claude` should work in a terminal)

## Run it

```bash
npm install
npm run dev      # terminal 1 — Vite dev server on :5199
npm run electron # terminal 2 — launches the app against the dev server
```

For a quick run against the built bundle (still needs node_modules):

```bash
npm run dev:app  # vite build, then electron .
```

## Build a real app (no terminal, no Vite)

```bash
npm run build    # stages runtime files, emits release/Claude Code-darwin-arm64/Claude Code.app
npm run verify   # launches the bundle and checks it end to end
npm run release  # both, in order
```

Then install it:

```bash
cp -R "release/Claude Code-darwin-arm64/Claude Code.app" /Applications/
```

The bundle is ~233 MB, almost all of it the Electron runtime. `Contents/Resources/app.asar`
is only ~226 KB because only `dist/` and `electron/` are staged into it — no sources,
no `node_modules`, no Vite. Open it from Finder or Spotlight like any other Mac app.

`npm run verify` is worth running after any change. It drives the actual packaged
binary with `PATH` stripped to the macOS default, the way Finder launches it, and
sends a real prompt through it. A dev-mode run cannot catch this class of bug because
it inherits your terminal's `PATH`.

Installing Electron may stall behind a slow GitHub connection. If `npm install` hangs,
use a mirror:

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
  npm install --registry=https://registry.npmmirror.com
```

Set the same `ELECTRON_MIRROR` when you build, or the packager will miss the cached
Electron zip and hang reaching GitHub (see the note in `scripts/build-app.cjs`).

## Using it

Open a folder with the `⌂` button in the explorer (or `Cmd+O`). That begins a session
in that directory — everything Claude does is scoped to it. Type in the box at the
bottom right; `Cmd+K` jumps there from anywhere.

A few things worth knowing:

- **Language** — the `中文 / EN` toggle sits in the chat toolbar. The app follows your
  system language on first launch and remembers your choice afterwards. Both languages
  come from one string table (`src/lib/i18n.jsx`), so nothing is duplicated per-locale.
  Interface text switches; **what you type is sent to Claude as-is**, so prompts in
  Chinese get Chinese answers.
- **Models and permissions** are the two dropdowns above the transcript. Changing
  either restarts the process but resumes the same session, so context survives.
- **Stop** interrupts the current turn. `--print` mode has no interactive interrupt
  channel, so this recycles the process and resumes by session id on your next message.
- **Sessions** live under the clock icon. They are read from
  `~/.claude/projects/<slugified-cwd>/*.jsonl`, the same files the CLI writes, so
  anything you did in the terminal is listed here too. Resuming one continues that
  conversation — its earlier messages are not re-rendered.
- **Tool cards** are collapsed by default. Click the header to expand, which shows the
  full command, the file contents, or the diff. Clicking a file path opens it in the
  editor.
- Files Claude edits get an orange dot in the explorer and a marker on their tab.

## 使用说明

点资源管理器顶部的 `⌂`（或 `Cmd+O`）选择工作目录，会话就在该目录下开始，Claude 的所有
操作都限定在此范围。在右下角输入框提问，`Cmd+K` 可从任意位置跳回输入框。

几个要点：

- **语言切换**在对话栏的 `中文 / EN` 按钮。首次启动会跟随系统语言，之后记住你的选择。
  两种语言共用同一份词条表（`src/lib/i18n.jsx`），不存在按语言重复的代码。
  切换的只是界面文案；**你输入的内容原样发给 Claude**，所以用中文提问就会得到中文回答。
- **模型和权限模式**是对话上方那两个下拉框。改动会重启进程，但通过 `--resume` 接回同一
  会话，上下文不丢。
- **停止**按钮中断当前回合。`--print` 模式没有交互式中断通道，因此这里是重启进程，
  下一条消息会按 session id 续上。
- **历史会话**在左侧时钟图标下，读的是 `~/.claude/projects/<路径slug>/*.jsonl`，
  和 CLI 写的是同一批文件，所以你在终端里做过的会话也会列出来。恢复会话会接着聊，
  但更早的消息不会重新渲染。
- **工具卡片**默认折叠，点标题展开可看完整命令、文件内容或 diff。点卡片里的文件路径
  会在编辑器中打开。
- Claude 改过的文件，资源管理器里会显示橙色圆点，标签页上也有标记。


## How it works

```
electron/main.cjs          window, IPC, workspace file tree, session history
electron/claude-agent.cjs  one `claude` subprocess per window, NDJSON in/out
electron/find-claude.cjs   locates the claude binary and builds the child PATH
electron/preload.cjs       contextBridge surface (window.api)
src/App.jsx                transcript assembly + session lifecycle
src/lib/i18n.jsx           EN/中文 string tables, provider, useI18n()
src/components/            Sidebar, EditorPane, ChatPanel, Message, ToolCard, Markdown
src/lib/format.js          markdown → HTML, diff lines, path/cost/token formatting
scripts/build-app.cjs      stages runtime files and runs electron-packager
scripts/verify-app.mjs     launches the packaged .app with a bare PATH and tests it
```

`electron/find-claude.cjs` exists because of how macOS launches apps: a double-clicked
app gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which does not include the npm global bin
directory where `claude` normally lives. The module checks the known install locations,
falls back to asking the user's login shell, and caches the answer.

Error strings are the one thing that crosses the process boundary: the main process
returns an `errorKey` (e.g. `err.spawn`) plus a detail string, and the renderer
translates it. That way main-process errors follow the UI language instead of being
baked into whichever locale was compiled in.

The CLI is spawned once per session rather than once per message, so it stays warm:

```
claude -p --input-format stream-json --output-format stream-json \
       --verbose --include-partial-messages \
       --model <alias> --permission-mode <mode> [--resume <session-id>]
```

Messages go in on stdin as `{"type":"user","message":{...}}`. Events come back on
stdout as newline-delimited JSON — `system` (init), `assistant`, `user` (tool results),
`stream_event` (per-token deltas), and `result` (cost and duration). `claude-agent.cjs`
coalesces the token deltas on a 60ms timer so the renderer isn't re-rendered per
character, and flushes them when the authoritative message arrives.

## Known limits

- CLI upgrades can change event shapes; the parser ignores unknown records rather than
  failing, but a new block type would render as nothing.
- The editor is a read-only viewer. Editing is Claude's job — ask in the chat.
- No syntax highlighting inside the editor pane yet; language and line numbers only.
- One window, one workspace folder, one session at a time.
- The bundle is unsigned and unnotarized. First launch may need
  System Settings → Privacy & Security → "Open Anyway", or
  `xattr -dr com.apple.quarantine "/Applications/Claude Code.app"`.
- `claude` must already be installed and authenticated on the machine; the app drives
  your existing CLI and does not bundle it.
