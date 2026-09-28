# Architecture

This document explains *why* Ducky Coder Lite is built the way it is. Most of
the interesting decisions follow from a single constraint: **the target machine
has 2 GB of RAM.**

---

## 1. The memory budget, stated honestly

| Component | Budget | Why |
| --- | --- | --- |
| Rust backend | 20–40 MB | One PTY reader thread per terminal with a fixed 16 KB buffer; one watcher thread; no caches |
| Web view (engine + UI) | 100–200 MB | Chromium's floor, plus our DOM; bounded by keeping documents in one editor |
| Open documents | ~1 MB each | Only the active tab plus a small warm window |
| **Total** | **~150–300 MB** | Leaves the rest of 2 GB for your project, your browser, and the OS |

The status bar reports the real measured number, read from `/proc/meminfo` and
from the RSS of the editor process *and* its WebKit helper processes. Counting
only our own process would badly understate the truth on Linux, because the
webview is a separate process.

---

## 2. There is no document store

**Decision.** Open documents live in the webview, where they are already being
displayed. The backend re-reads a file from disk when a suspended tab is
reopened. There is no document cache, no invalidation logic, and no
synchronisation.

**Why.** A document cache in the backend means two copies of every open file —
one in Rust, one in the webview — plus a protocol for keeping them consistent and
a policy for evicting. Suspending a tab would then need to invalidate both sides.
Instead there is exactly one copy, owned by the only component that needs it, and
closing a tab frees memory on both sides of the bridge with no coordination at
all.

### 2.1 One editor instance, not one per tab

`EditorHost` creates a single `CodeMirror` `EditorView` for the whole
application. Switching tabs swaps the `Text` document and rebuilds the state.

**Why.** One editor per tab is the single largest source of avoidable memory in
a tabbed editor. Twenty tabs means twenty syntax highlighters, twenty sets of
DOM measurements, twenty undo histories, and twenty sets of viewport caches — all
for files the user is not currently looking at. With one instance, the editor's
memory is a function of *the file you are looking at*, not of how many files you
have open. It also makes per-file "language services" trivial to suspend: there is
only one to suspend.

### 2.2 Tab suspension is an LRU with a moving budget

`store.warmTabLimit()` is the dial:

| State | Warm tabs |
| --- | --- |
| Normal | `warmTabLimit` (default 3) |
| Elevated memory | 1 |
| Critical memory | 0 |
| Low Memory Mode off | at least 4 |

Beyond the window, a tab's text is dropped and it is marked `suspended`.
Reopening re-reads it from disk. The tab keeps its identity, dirty flag and
language, so reopening feels continuous rather than like a new file.

---

## 3. There is no repository index

**Decision.** No file list, no symbol table, no content index, at any point.

**Why.** A workspace index on a 48,000-file repository is hundreds of megabytes
before it is useful, it must be built (blocking, or in a worker that competes
with the editor for every core), and it goes stale constantly. The alternative is
retrieval at query time, which is cheap precisely because the queries are small:

- **The explorer** calls `read_dir` on exactly one directory, when the user
  expands it. `TreeNode.children === null` means "not loaded yet".
- **Search** walks on demand, streams results, and stops the instant it reaches
  its result cap. A new keystroke cancels the previous search.
- **Context retrieval** runs a small, bounded search, ranks the hits, reads only
  the matching regions of the top few files, and stops at the token budget.

A 48,000-file repository therefore costs the editor the same memory as a 12-file
one. The explorer's folder tree is virtualised as well: rows are created only for
the visible window and recycled on scroll, so a folder with 20,000 files does not
create 20,000 DOM nodes.

---

## 4. There is no language server

**Decision.** No LSP. Diagnostics come from small in-process analysers.

**Why.** A language server is a separate process — Node, JVM, or a native binary —
and each one routinely costs 150–400 MB. Two of them exceeds the entire budget.
Running them would also force the editor to be a long-lived process supervisor
rather than a window.

What we do instead, all in ~200 lines, on a debounce, with a bail-out on large
files:

- unbalanced and mismatched brackets (string- and comment-aware)
- unresolved merge conflict markers
- Python indentation that matches no enclosing block
- `TODO` / `FIXME` / `HACK` markers for the Problems panel

This reports what it can prove and stays silent otherwise, rather than pretending
to be a compiler. The trade-off is explicit and documented in the app: you do not
get semantic type errors. The status bar tooltip and the Performance settings
page both say so.

---

## 5. Inference is remote, and that is a memory decision

**Decision.** No local model. Ducky Coder Lite talks to a remote provider.

**Why.** A 3B-parameter model needs ~2 GB in FP16 and several GB quantised. On a
2 GB machine it is not a slow feature request, it is the whole machine. This is
not a compromise: it is the reason the rest of the app can be so light.

It also produces a useful second-order effect. Because the provider is remote and
billed per token, we are as motivated as the user's RAM to keep the context
small. The two constraints turn out to be the same constraint, which is why
"engineered for 2 GB" produces a *better* AI editor rather than a crippled one.

### 5.1 The context pipeline

```
user question
    ↓
salient terms extracted (stopwords dropped, identifiers preferred)
    ↓
bounded workspace search, 60 hits per term
    ↓
rank hits (definition sites beat stray mentions)
    ↓
read excerpts — whole file if small, windows around matches if large
    ↓
follow imports one level deep (highest-value links in real code)
    ↓
fill the token budget, then stop
    ↓
render a compact context block
```

Every step has a cap. The cap is configurable in **Settings › Ducky AI** and the
result is inspectable before anything is sent.

### 5.2 Autocomplete discipline

An implementation that requests a completion per character is broken three ways:
it burns quota, it pins memory in the HTTP client, and the latency means the
suggestion arrives after the user has moved on. Four gates must pass before a
byte leaves the machine:

1. **Intent** — only where a completion belongs: after `(`, `,`, `=`, `:`, a
   dot, or a partial word. Never inside a comment.
2. **Debounce** — configurable, and longer in Low Memory Mode.
3. **Context budget** — a small window around the cursor (2.4 KB in Low Memory
   Mode, 6 KB otherwise). Never the file. Never the project.
4. **Cancellation** — a newer request supersedes the previous one, so token spend
   stops immediately.

The local completion sources (keywords, snippets, words from this file) are
synchronous and always available, so the popup appears instantly on an offline
or unconfigured machine and the AI entry joins it when it arrives.

---

## 6. Exactly one watcher

**Decision.** One background thread. It wakes every 2 seconds, reads
`/proc/meminfo` and the process RSS of itself and its children, and emits a
snapshot when the pressure level changes.

**Why.** Every polling loop is a permanent tax on a machine that has no spare
CPU. There is no git status loop — Git status is fetched when the SCM view opens,
when the user acts, and after a save *while the SCM view is open*. There is no file
watcher, no heartbeat, no telemetry, no indexer.

Terminal reader threads are the only other threads, one per open terminal, each
holding a fixed 16 KB staging buffer regardless of how much the command prints.

---

## 7. Terminal scrollback lives in exactly one place

**Decision.** The backend is a **stateless pipe**. PTY bytes go to the renderer
and are not buffered in Rust. The frontend owns a bounded `string[]` per
terminal.

**Why.** The obvious design — keep the last N lines in the backend so the UI can
ask for them again — duplicates the entire scrollback across the process boundary.
A 750-line buffer then costs twice, and a tab-suspend feature would have to
synchronise the two. With the buffer in one place, dropping it is free, and
"reopen a suspended terminal" simply means showing an empty terminal attached to
the same live process, which is what a user expects anyway (the process kept
running).

The cap is the important part: 750 lines by default, 300 in Low Memory Mode. A
`npm run build` that prints 200,000 lines cannot exhaust the editor's memory.

---

## 8. The pressure ladder

`Pressure` has three levels, and the editor only ever moves down it
automatically.

| Level | Trigger | Response |
| --- | --- | --- |
| Normal | — | Everything runs |
| Elevated | free < `shedThresholdMb` (256 MB) | Trim caches, warm tabs drop to 1, stop background search, notify |
| Critical | free < `criticalThresholdMb` (128 MB) | Warm tabs drop to 0, AI context shrinks, autocomplete is suppressed, notify |

Recovery needs *more* headroom than falling does (a 64 MB band), so a machine
hovering at the boundary does not flap between two behaviours — thrashing is
worse than either state. The notice the user sees names the reason explicitly:

> Ducky Coder Lite reduced background activity because system memory is low.

---

## 9. Privacy and secrets

- API keys live in a `0600` file, written with the correct mode from the first
  byte so they are never briefly world-readable.
- The UI is **write-only** for credentials: `secret_status` returns *whether* a key
  exists, never the key. There is no code path that can display one.
- Every outbound error passes through `secret::redact`, which strips
  `Authorization: Bearer …`, `sk-`/`ghp_`/`github_pat_`/`xai-` prefixed tokens and
  long high-entropy alphanumeric runs.
- The terminal's child process has key environment variables **removed**, so
  typing `env` in your shell cannot print one.
- Command output is scrubbed again on the way back, as defence in depth.

---

## 10. Failure behaviour

AI, Git, the terminal and the project tree are each optional and independently
degradable:

| Failure | Behaviour |
| --- | --- |
| No provider configured | Every AI action says so and offers Settings. Editing is unaffected. |
| Provider offline | The error is shown once; the editor keeps working. In-flight requests are cancellable. |
| Internet down | Same as offline. Autocomplete silently declines. |
| `git` missing | The SCM panel explains it and offers to initialise a repository. No polling, so no cost. |
| Terminal fails to start | A toast; the panel stays usable. |
| A file is corrupt or binary | The tab renders a clear message instead of stalling. |
| Very large file | Capped read, reduced analysis, and above `hugeFileBytes` it is refused with an explanation. |
| Memory critically low | Ladder sheds load. The editor does not crash. |
| A settings file is corrupt | It is backed up and defaults are used, so the editor still starts. |

---

## 11. The frontend has no framework

**Decision.** Plain TypeScript with a ~60-line `h()` helper and direct, local DOM
updates. No React, no virtual DOM.

**Why.** A framework runtime is dead weight when the budget is 2 GB, and more
importantly it is *retained* memory: a large component tree and its reconciliation
state live for the whole session. The UI here is a fixed, well-understood set of
panels, so explicit local updates are both smaller and faster than a diff — and
they make the memory cost legible: what is in the DOM is what exists.

Panels are created once and toggled, never destroyed and rebuilt, which keeps
scroll positions, focus and CodeMirror's viewport cache intact.

---

## 12. What is deliberately missing

Stated plainly, because a design document that only lists strengths is not useful:

- **No semantic language intelligence.** No type errors, no cross-file
  diagnostics, no go-to-definition across files. This buys back ~300–800 MB.
- **No extension ecosystem.** The extension host is a card list, not a runtime.
  Third-party code in-process is an unbounded-memory risk this app refuses to
  take on. A well-behaved out-of-process host could be added without touching the
  memory model.
- **No local inference.** Not a limitation to work around; the reason the rest of
  the app fits.
- **No multi-window / split editors.** One editor group, because each additional
  `EditorView` costs real memory.
- **Formatting is language-agnostic.** Trailing whitespace and final newlines
  only. Real formatters are per-language binaries or a dependency the app does not
  carry.

Each of these is a decision about what a 2 GB machine can afford, and the
trade-off is surfaced in the UI rather than hidden.
