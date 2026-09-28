# Ducky Coder Lite

**Code fast. Stay light.**

A lightweight AI coding environment engineered from the ground up for computers
with **2 GB of RAM**.

Ducky Coder Lite gives you the workflow people expect from a modern AI-first
editor — project explorer, tabbed editor, command palette, integrated terminal,
source control, AI chat, inline AI editing, an agent that can propose changes,
diffs with explicit approval, and autocomplete — on a machine that most editors
would struggle to launch on.

---

## Why this exists

A modern AI editor typically needs 8–16 GB of RAM. The usual reason is not the
UI: it is language servers, file watchers, a prebuilt workspace index, an Electron
runtime, and a browser engine holding several large documents at once.

Ducky Coder Lite removes all of those costs rather than tuning them:

| Instead of | Ducky Coder Lite does |
| --- | --- |
| Running inference locally | Sends requests to a remote provider you configure. No model is ever loaded on your machine. |
| A prebuilt workspace index | Retrieves context on demand, per question, capped by a token budget. |
| One editor per tab | **One** editor instance for the whole app; tab switches swap the document. |
| A language server per language | Small in-process analysers for brackets, quotes, merge markers and Python indentation. |
| A repository tree loaded up front | The folder tree is built one directory at a time, as you expand it. |
| An unbounded terminal buffer | A hard-capped ring buffer, default 750 lines. |
| Background polling | Exactly **one** watcher thread, reading memory every 2 seconds. |

The result: the editor itself targets **150–300 MB**, and it stays responsive
because it is never doing work it does not need to.

---

## Features

**Editor**
- Syntax highlighting for 30+ languages, loaded one language at a time on demand
- Line numbers, code folding, bracket matching, multi-cursor, find and replace,
  go to line, hover, word wrap
- Virtual rendering: only the visible viewport is ever built, so a 200,000-line
  file costs about the same as a 200-line one
- Problems panel with *Ask Ducky AI to Fix*

**Cursor-style tabs**
- Preview tabs, pinning, dirty indicators, drag reordering, restore closed tabs
- **Tab suspension**: inactive tabs beyond a small warm window release their text
  and are re-read from disk on reopen. The warm window shrinks automatically when
  memory gets tight

**Ducky AI**
- Chat with streaming responses
- **Agent mode**: propose file changes and shell commands
- **Inline AI editing** with a diff and Accept / Reject / Accept All / Reject All
- **AI autocomplete** that is debounced, cancellable and only fires where a
  completion makes sense
- **Composer** for larger, plan-first changes
- **Context control**: see exactly which files and how many tokens are sent, per
  file, and add or remove them
- Conversation memory is bounded and compressed, never written to disk, and
  released immediately on *Clear Chat*
- Works with any OpenAI-compatible endpoint, Ollama, or Ducky AI's own endpoint

**Workspace**
- Lazy folder tree with file-type badges, new file/folder, rename, delete, move
- Streaming workspace search with regex, whole-word and case options, replace
  across files, and standard ignore rules
- Lightweight Git: status, diff, stage, unstage, commit, branch, checkout, pull,
  push, history
- Integrated PTY terminal with multiple tabs, bounded scrollback, output search
  and copy

**Resource control**
- **Low Memory Mode** (on by default): disables the minimap and animations,
  reduces analysis and autocomplete, limits indexing, suspends inactive tabs and
  shrinks caches
- **Automatic memory protection**: a watcher sheds work in two steps as free
  memory falls, and tells you what it changed
- A status bar indicator with real measured numbers, which you can turn off

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `P` | Quick Open |
| `Ctrl`/`Cmd` + `Shift` + `P` | Command Palette |
| `Ctrl`/`Cmd` + `Shift` + `F` | Search Workspace |
| `Ctrl`/`Cmd` + `Shift` + `A` | Ducky AI |
| `Ctrl`/`Cmd` + `I` | Ducky AI: edit selection |
| `Ctrl`/`Cmd` + `Shift` + `I` | Ducky AI: Composer |
| `Ctrl`/`Cmd` + `` ` `` | Toggle terminal |
| `Ctrl`/`Cmd` + `B` | Toggle sidebar |
| `Ctrl`/`Cmd` + `J` | Toggle bottom panel |
| `Ctrl`/`Cmd` + `S` / `Shift`+`S` | Save / Save all |
| `Ctrl`/`Cmd` + `W` | Close tab |
| `Ctrl`/`Cmd` + `Shift` + `T` | Reopen closed tab |
| `Ctrl`/`Cmd` + `G` | Go to line |
| `Alt` + `1`–`5` | Jump to tab |
| `Escape` | Close overlay, or stop a running AI request |

On macOS, `Cmd` replaces `Ctrl` throughout.

---

## Building

Requires **Rust 1.77+**, **Node 20+**, and the Tauri platform prerequisites.

### Check your cargo version first

This is the single most common way to get a confusing failure. Some Linux
distributions still ship a very old `cargo` - Debian 12 has 1.65, for example -
and it predates the `dep:` weak-feature syntax used across the modern dependency
ecosystem. An old cargo does not fail cleanly: it reports errors that have
nothing to do with the real cause, such as

```
error: failed to select a version for `js-sys`
  the package `reqwest` depends on `js-sys`, with features: `futures-util`
  but `js-sys` does not have these features
```

That is not a real dependency conflict, and no edit to `Cargo.toml` will fix it.
Check what you have:

```bash
cargo --version
```

If it is older than 1.77, install a current toolchain:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

`scripts/build-lowmem.sh` prefers `~/.cargo/bin` automatically and refuses to
run on a cargo that is too old, saying so plainly.

### Linux

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev patchelf build-essential libssl-dev
```

### macOS

```bash
xcode-select --install
```

### Windows

Install the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
and the Visual Studio C++ build tools.

Then:

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # production bundle
```

### Building on a small machine

The dependency tree is large and `rustc` is memory-hungry: compiling it spawns
one process per crate, and a parallel build can peak well above 2 GB. There is a
script that pins cargo to a single job and disables debug info:

```bash
./scripts/build-lowmem.sh check     # compile-check the backend only
./scripts/build-lowmem.sh test      # run the backend unit tests
./scripts/build-lowmem.sh           # everything, then the release bundle
```

It is safe to interrupt with Ctrl-C; cargo resumes where it stopped.

If you would rather do it by hand, the equivalent environment is:

```bash
CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 cargo check --lib
```

**Do not run `npm run tauri build` with the default parallelism on a 2 GB
machine.** That is the command that will get the process OOM-killed.

---

## Configuring Ducky AI

AI is entirely optional — the editor works with no provider configured.

1. Open **Settings › Ducky AI**
2. Choose a provider: Ducky AI, any OpenAI-compatible endpoint, or Ollama
3. Paste your API key and press **Test**

The key is written to a file only your user account can read (`0600`), and is
never displayed again, never logged, never printed to the terminal, and never
included in anything sent to the model. You can also supply it through the
`DUCKY_AI_KEY` environment variable, in which case it never touches disk.

**Nothing is uploaded automatically.** Ducky Coder Lite only reads files from
disk when you ask a question or select code, and only sends what fits the context
budget. The context chip above the chat shows the file count and token count, and
clicking it lists every file with the reason it was included.

---

## Privacy

- API keys are stored with owner-only permissions and are redacted from every log,
  error message, terminal stream and AI context
- The terminal does not inherit key environment variables
- No telemetry; nothing is written to a log file
- Workspace contents leave your machine only when you send an AI request, and only
  the files listed in the context inspector
- You can disable project context entirely in **Settings › General**

---

## Project layout

```
src/                    frontend (TypeScript, no UI framework)
  core/                 IPC bridge, reactive store, DOM helpers
  editor/               CodeMirror host, theming, diagnostics, AI autocomplete
  ui/                   shell, panels, palette, diff, settings, icons
src-tauri/              backend (Rust)
  src/meminfo.rs        system + process memory accounting
  src/state.rs          shared state and the memory-pressure ladder
  src/fsops.rs          lazy filesystem access, path sandboxing
  src/search.rs         streaming, bounded, cancellable search
  src/ai.rs             remote inference, on-demand context retrieval
  src/pty.rs            real PTY terminal
  src/git.rs            git CLI integration
  src/secret.rs         credential storage and redaction
  src/config.rs         settings
  src/commands.rs       the Tauri command surface
docs/ARCHITECTURE.md    why the design is shaped this way
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the reasoning behind the
memory decisions.

---

## License

MIT.
