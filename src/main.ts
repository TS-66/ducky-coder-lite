/**
 * Ducky Coder Lite — entry point.
 *
 * Responsibilities, in order:
 *   1. build the shell;
 *   2. start the one editor instance;
 *   3. wire the views to the store;
 *   4. register the commands and keyboard bindings;
 *   5. subscribe to the backend's memory watch.
 *
 * ## Startup order
 *
 * The shell paints before anything else is touched. AI, Git, the terminal, the
 * extensions view and the project tree are all initialised lazily, on first
 * use. On a slow machine the difference between "the window is up in 300 ms"
 * and "the window is up in 3 s" is the difference between an editor that feels
 * native and one that feels broken.
 */

import "./style.css";
import "./ui/layout.css";

import { initBridge, api, on, DuckyError } from "./core/backend";
import type { MemEvent, AppInfo } from "./core/backend";
import {
  store,
  loadSettings,
  applySettingsToDom,
  openFile,
  closeTab,
  saveTab,
  saveAll,
  reopenClosedTab,
  toast,
  type State,
  type PanelId,
} from "./core/store";

import { createShell, renderShell, renderBottomTabs, renderWelcome } from "./ui/shell";
import { renderTabs, resetTabSignature } from "./ui/tabs";
import { renderStatusBar, setCursorPos } from "./ui/statusbar";
import {
  renderExplorer,
  installExplorerInteractions,
  refreshTree,
  openMenu,
} from "./ui/explorer";
import {
  renderAiPanel,
  showModal,
  stopStreaming,
  newConversation,
  clearChat,
  installStreamListeners,
} from "./ui/ai-panel";
import {
  renderTerminal,
  installTerminal,
  createTerminal,
  clearActiveTerminal,
  resizeActive,
  terminalKeyHandler,
  outputElement,
} from "./ui/terminal";
import { renderSearch, focusSearch, refreshScm, renderScm, renderRun, renderExtensions, renderProblems } from "./ui/panels";
import { openCommandPalette, openQuickOpen, type Command } from "./ui/palette";
import { openSettings } from "./ui/settings";
import { openInlineAi, setEditorHost, setFocusTarget, runQuickAction } from "./ui/inline-ai";
import { openDiff } from "./ui/diff";
import { KeyboardManager, DEFAULT_BINDINGS } from "./ui/keybinds";
import { EditorHost, applyEditorVars } from "./editor/editor";
import { setFallbackLanguage } from "./editor/ai-complete";
import { icons } from "./ui/icons";
import { h, IS_MAC, keyCombo, raf } from "./core/dom";
import { forceLinting } from "@codemirror/lint";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initBridge();

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");

// The title bar's own controls. Back/forward walk the tab history the shell
// already keeps, and each right-hand button opens the surface its indicator
// describes -- so nothing in the bar is decorative-only.
const shell = createShell(root, {
  onBack: () => historyNav(-1),
  onForward: () => historyNav(1),
  onOpenModelPicker: () => openSettings("ai"),
  onOpenAccount: () => openSettings("general"),
  onOpenIndexingInfo: () => {
    store.update((st) => {
      st.activePanel = "search";
      st.panelVisible = true;
    });
  },
});
const keyboard = new KeyboardManager();

/**
 * Window history: the stack of tabs the user has focused, most recent last.
 *
 * The title bar's chevrons walk it. It is a real stack rather than "previous
 * tab", so back-then-forward returns to exactly where you came from -- which is
 * what people expect from a browser, and what they notice immediately when it
 * is missing.
 */
const tabHistory: string[] = [];
let historyCursor = -1;

function noteTabFocus(id: string | undefined): void {
  if (!id) return;
  // Truncate anything ahead of the cursor: once you go back and then open a
  // different file, the forward entries no longer describe a path you can take.
  if (historyCursor < tabHistory.length - 1) tabHistory.length = historyCursor + 1;
  if (tabHistory[historyCursor] === id) return;
  tabHistory.push(id);
  historyCursor = tabHistory.length - 1;
}

function historyNav(delta: number): void {
  const next = historyCursor + delta;
  if (next < 0 || next >= tabHistory.length) return;
  const id = tabHistory[next];
  // Do not push onto the stack while walking it, or the cursor drifts.
  historyCursor = next;
  store.update((st) => {
    if (st.tabs.some((t) => t.id === id)) st.activeTabId = id;
  });
}

// Record focus changes so the title bar's chevrons have something to walk.
// Subscribing rather than instrumenting every call site means a tab opened
// from the explorer, a diff, or the quick-open palette all land in the history
// without each of them having to remember.
store.subscribe(() => {
  noteTabFocus(store.state.activeTabId ?? undefined);
});
let editor: EditorHost | null = null;
let appInfo: AppInfo | null = null;
let composerOpen = false;

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

editor = new EditorHost(shell.editorHost, {
  onChange: (path, content) => {
    store.update((s) => {
      const tab = s.tabs.find((t) => t.path === path);
      if (!tab) return;
      // Do not clobber a tab whose content was replaced underneath us (an
      // external change, or a document that is no longer loaded).
      if (tab.content === undefined) return;
      if (tab.content === content) return;
      tab.content = content;
      tab.dirty = true;
    });
  },
  onCursor: (_path, line, column) => {
    setCursorPos(line, column);
  },
  onSave: (path) => {
    const tab = store.state.tabs.find((t) => t.path === path);
    if (tab) void saveTab(tab.id).then((ok) => ok && refreshScmQuietly());
  },
  getSettings: () => store.state.settings ?? fallbackSettings(),
  onInlineAI: () => openInlineAi(),
});

setEditorHost({
  getSelection: () => editor!.selection,
  getContent: () => editor!.content,
  getPath: () => editor!.path,
  getLanguage: () => store.state.tabs.find((t) => t.id === store.state.activeTabId)?.language ?? "plaintext",
  // The status bar keeps the authoritative cursor position; the editor reads
  // it from there rather than duplicating the state.
  getCursor: () => ({ line: cursorLine(), column: cursorColumn() }),
  replaceAll: (content: string) => editor!.replaceAll(content),
  getRange: () => null,
});
setFocusTarget({ focus: () => editor?.focus() });

let cursor = { line: 1, column: 1 };
function cursorLine(): number {
  return cursor.line;
}
function cursorColumn(): number {
  return cursor.column;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const paint = raf(() => {
  const s = store.state;
  renderShell(shell, s);
  shell.titleBar.render(s);
  renderTabs(shell.editorTabs, s);
  renderStatusBar(shell.statusLeft, shell.statusRight, s);
  if (s.bottomPanel) renderBottomTabs(shell, s);
  if (s.settings) applyEditorVars(shell.editorHost, s.settings);
  renderWelcome(shell, s, {
    onOpenFolder: () => void pickFolder(),
    onCreateProject: () => void createProject(),
    onConnectAI: () => {
      openSettings("ai");
      store.update((st) => {
        st.aiPanelVisible = true;
      });
    },
  });
});

store.subscribe(() => {
  paint();
  // Keep the active document in sync with the selected tab.
  void syncEditorToActiveTab();
});

// ---------------------------------------------------------------------------
// Editor <-> tab synchronisation
// ---------------------------------------------------------------------------

let lastShownTabId: string | null = null;
let lastShownContent: string | null = null;

async function syncEditorToActiveTab(): Promise<void> {
  const s = store.state;
  const tab = s.tabs.find((t) => t.id === s.activeTabId);

  if (!tab) {
    if (lastShownTabId !== null) {
      editor!.clear();
      lastShownTabId = null;
      lastShownContent = null;
    }
    return;
  }

  if (tab.id === lastShownTabId) {
    // Same tab: push external content changes (an applied AI edit, a replace-all)
    // without rebuilding the document, which would lose the cursor.
    if (tab.content !== undefined && tab.content !== lastShownContent) {
      const current = editor!.content;
      if (current !== tab.content) {
        const hadFocus = editor!.view.hasFocus;
        editor!.replaceAll(tab.content);
        if (hadFocus) editor!.focus();
      }
      lastShownContent = tab.content;
    }
    return;
  }

  // Different tab: swap the document. A suspended tab is re-read on demand.
  if (tab.content === undefined) {
    editor!.clear();
    lastShownTabId = null;
    lastShownContent = null;
    // Reopen through the normal path, which re-reads from disk.
    await openFile(tab.path, { preview: false });
    return;
  }

  lastShownTabId = tab.id;
  lastShownContent = tab.content;
  setFallbackLanguage(tab.language);
  await editor!.show(tab.path, tab.content, tab.language);
  editor!.focus();
}

function cursorChanged(line: number, column: number): void {
  cursor = { line, column };
}

// Wire the status bar's cursor updates back into the editor callback.
store.subscribe(() => {
  const s = store.state;
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (tab) setFallbackLanguage(tab.language);
  void tab;
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

shell.views.set("explorer", (host) => {
  const s = store.state;
  renderExplorer(host, s);
});
shell.views.set("search", (host, s) => renderSearch(host, s));
shell.views.set("scm", (host) => {
  renderScm(host);
});
shell.views.set("run", (host) => renderRun(host));
shell.views.set("extensions", (host) => renderExtensions(host));
shell.views.set("ducky", (host, s) => renderAiPanel(host, s));

shell.bottomViews.set("terminal", (host, s) => renderTerminal(host, s));
shell.bottomViews.set("problems", (host, s) => renderProblems(host, s));
shell.bottomViews.set("output", (host) => {
  host.textContent = "";
  host.appendChild(
    h(
      "div",
      { class: "panel-empty" },
      h("div", { class: "panel-empty-title" }, "Output"),
      h(
        "div",
        { class: "panel-empty-text" },
        "Messages from Ducky Coder Lite's own processes appear here. Nothing is logged to disk, and no workspace content is ever written to a log.",
      ),
    ),
  );
});

installExplorerInteractions(shell.sidebarContent);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMANDS: Command[] = [
  // File
  { id: "file.new", title: "New File", category: "File", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+N`, icon: icons.file, run: () => newFile() },
  { id: "file.openFolder", title: "Open Folder", category: "File", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+K`, icon: icons.folder, run: () => void pickFolder() },
  { id: "file.save", title: "Save", category: "File", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+S`, icon: icons.check, run: () => void saveActive() },
  { id: "file.saveAll", title: "Save All", category: "File", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+Shift+S`, icon: icons.check, run: () => void saveAll() },
  { id: "file.close", title: "Close Tab", category: "File", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+W`, icon: icons.close, run: () => void closeActive() },
  { id: "file.reopen", title: "Reopen Closed Tab", category: "File", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+Shift+T`, icon: icons.history, run: () => void reopenClosedTab() },
  { id: "file.quickOpen", title: "Go to File…", category: "File", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+P`, icon: icons.search, run: () => void openQuickOpen() },
  { id: "file.revealExternal", title: "Reveal Active File in File Manager", category: "File", icon: icons.folderOpen, run: () => revealExternal() },

  // Edit
  { id: "edit.inlineAI", title: "Ducky AI: Edit Selection", category: "Edit", shortcut: keyCombo("mod+i"), icon: icons.sparkle, run: () => openInlineAi() },
  { id: "edit.explain", title: "Ducky AI: Explain Selection", category: "Edit", icon: icons.info, run: () => void runQuickAction("explain") },
  { id: "edit.fix", title: "Ducky AI: Fix Selection", category: "Edit", icon: icons.bolt, run: () => void runQuickAction("fix") },
  { id: "edit.refactor", title: "Ducky AI: Refactor Selection", category: "Edit", icon: icons.edit, run: () => void runQuickAction("refactor") },
  { id: "edit.tests", title: "Ducky AI: Generate Tests", category: "Edit", icon: icons.check, run: () => void runQuickAction("tests") },
  { id: "edit.docs", title: "Ducky AI: Add Documentation", category: "Edit", icon: icons.file, run: () => void runQuickAction("docs") },
  { id: "edit.optimize", title: "Ducky AI: Make This Faster", category: "Edit", icon: icons.bolt, run: () => void runQuickAction("optimize") },
  { id: "edit.format", title: "Format Document", category: "Edit", icon: icons.edit, run: () => formatDocument() },
  { id: "edit.gotoLine", title: "Go to Line…", category: "Edit", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+G`, icon: icons.arrowRight, run: () => promptGotoLine() },
  { id: "edit.toggleWordWrap", title: "Toggle Word Wrap", category: "Edit", icon: icons.split, run: () => void toggleWordWrap() },

  // View
  { id: "view.sidebar", title: "Toggle Sidebar", category: "View", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+B`, icon: icons.explorer, run: () => toggleSidebar() },
  { id: "view.bottom", title: "Toggle Bottom Panel", category: "View", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+J`, icon: icons.terminal, run: () => toggleBottom() },
  { id: "view.problems", title: "Show Problems", category: "View", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+Shift+M`, icon: icons.problems, run: () => toggleProblems() },
  { id: "view.terminal", title: "Toggle Terminal", category: "View", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+\``, icon: icons.terminal, run: () => toggleTerminal() },
  { id: "view.zoomIn", title: "Zoom In", category: "View", icon: icons.plus, run: () => zoom(0.1) },
  { id: "view.zoomOut", title: "Zoom Out", category: "View", icon: icons.minus, run: () => zoom(-0.1) },
  { id: "view.resetZoom", title: "Reset Zoom", category: "View", icon: icons.refresh, run: () => zoom(0) },

  // Search
  { id: "search.workspace", title: "Search in Workspace", category: "Search", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+Shift+F`, icon: icons.search, run: () => focusSearch() },
  { id: "search.replace", title: "Replace in Files", category: "Search", icon: icons.edit, run: () => focusSearch() },

  // Terminal
  { id: "term.new", title: "Create New Terminal", category: "Terminal", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+Shift+\``, icon: icons.terminal, run: () => void createTerminal() },
  { id: "term.clear", title: "Clear Terminal", category: "Terminal", icon: icons.trash, run: () => clearActiveTerminal() },
  { id: "term.kill", title: "Kill Active Terminal", category: "Terminal", icon: icons.close, run: () => killActiveTerminal() },
  { id: "term.suggest", title: "Ducky AI: Suggest a Command", category: "Terminal", icon: icons.sparkle, run: () => void runQuickAction("command") },

  // Git
  { id: "git.refresh", title: "Refresh Source Control", category: "Git", icon: icons.refresh, run: () => { refreshScm(); showPanel("scm"); } },
  { id: "git.stage", title: "Stage All Changes", category: "Git", icon: icons.plus, run: () => void stageAll() },
  { id: "git.unstage", title: "Unstage All Changes", category: "Git", icon: icons.minus, run: () => void unstageAll() },
  { id: "git.commit", title: "Commit", category: "Git", icon: icons.gitCommit, run: () => promptCommit() },
  { id: "git.pull", title: "Pull", category: "Git", icon: icons.download, run: () => void gitAction("Pull", () => api.gitPull()) },
  { id: "git.push", title: "Push", category: "Git", icon: icons.arrowRight, run: () => void gitAction("Push", () => api.gitPush()) },

  // AI
  { id: "ai.toggle", title: "Show Ducky AI", category: "Ducky AI", shortcut: `${IS_MAC ? "⌘" : "Ctrl"}+Shift+A`, icon: icons.duck, run: () => toggleAi() },
  { id: "ai.composer", title: "Ducky AI: Composer", category: "Ducky AI", shortcut: keyCombo("mod+shift+i"), icon: icons.sparkle, run: () => openComposer() },
  { id: "ai.agent", title: "Ducky AI: Toggle Agent Mode", category: "Ducky AI", icon: icons.bolt, run: () => toggleAgentMode() },
  { id: "ai.new", title: "Ducky AI: New Conversation", category: "Ducky AI", icon: icons.plus, run: () => newConversation() },
  { id: "ai.clear", title: "Ducky AI: Clear Chat", category: "Ducky AI", icon: icons.trash, run: () => clearChat() },
  { id: "ai.settings", title: "Ducky AI: Configure Provider", category: "Ducky AI", icon: icons.settings, run: () => openSettings("ai") },
  { id: "ai.test", title: "Ducky AI: Test Connection", category: "Ducky AI", icon: icons.bolt, run: () => void testAi() },

  // Memory
  { id: "mem.toggle", title: "Toggle Low Memory Mode", category: "Memory", icon: icons.memory, run: () => void toggleLowMemory() },
  { id: "mem.release", title: "Release Memory Now", category: "Memory", icon: icons.memory, run: () => releaseMemoryNow() },
  { id: "mem.settings", title: "Low Memory Settings", category: "Memory", icon: icons.settings, run: () => openSettings("lowMemory") },
  { id: "mem.perf", title: "Performance Settings", category: "Memory", icon: icons.cpu, run: () => openSettings("performance") },

  // Settings and help
  { id: "settings.open", title: "Open Settings", category: "Preferences", icon: icons.settings, run: () => openSettings("general") },
  { id: "help.shortcuts", title: "Keyboard Shortcuts", category: "Help", icon: icons.info, run: () => showShortcuts() },
  { id: "help.about", title: "About Ducky Coder Lite", category: "Help", icon: icons.duck, run: () => showAbout() },
];

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function toggleSidebar(): void {
  store.update((s) => {
    s.sidebarVisible = !s.sidebarVisible;
  });
}

function toggleAi(): void {
  store.update((s) => {
    s.aiPanelVisible = !s.aiPanelVisible;
    if (s.aiPanelVisible) s.activePanel = "ducky";
  });
  if (store.state.aiPanelVisible && !store.state.settings?.ai.provider.hasKey) {
    // First use: point at setup without blocking the editor.
    toast("Ducky AI is not configured yet. Open Settings › Ducky AI to add a provider — or keep coding without it.", "info");
  }
}

function toggleAgentMode(): void {
  store.update((s) => {
    s.agentMode = !s.agentMode;
    s.aiPanelVisible = true;
  });
  toast(store.state.agentMode ? "Agent mode on. Ducky AI can propose edits and commands." : "Chat mode.");
}

function toggleBottom(): void {
  store.update((s) => {
    s.bottomPanel = s.bottomPanel ? null : "terminal";
  });
  if (store.state.bottomPanel === "terminal" && store.state.terminals.length === 0) {
    void createTerminal();
  }
}

function toggleProblems(): void {
  store.update((s) => {
    s.bottomPanel = s.bottomPanel === "problems" ? null : "problems";
  });
}

function toggleTerminal(): void {
  store.update((s) => {
    if (s.bottomPanel === "terminal") {
      s.bottomPanel = null;
    } else {
      s.bottomPanel = "terminal";
    }
  });
  if (store.state.bottomPanel === "terminal" && store.state.terminals.length === 0) {
    void createTerminal();
  }
}

async function killActiveTerminal(): Promise<void> {
  const id = store.state.activeTerminalId;
  if (id === null) return;
  await api.terminalKill(id);
  store.update((s) => {
    s.terminals = s.terminals.filter((t) => t.id !== id);
    s.activeTerminalId = s.terminals[0]?.id ?? null;
  });
}

function showPanel(id: PanelId): void {
  store.update((s) => {
    s.activePanel = id;
    s.sidebarVisible = true;
    s.aiPanelVisible = false;
  });
}

async function saveActive(): Promise<void> {
  const id = store.state.activeTabId;
  if (!id) return;
  const ok = await saveTab(id);
  if (ok) {
    const tab = store.state.tabs.find((t) => t.id === id);
    if (tab && store.state.settings?.editor.formatOnSave) formatDocument();
    refreshScmQuietly();
  }
}

async function closeActive(): Promise<void> {
  const id = store.state.activeTabId;
  if (id) await closeTab(id);
}

async function newFile(): Promise<void> {
  if (!store.state.workspace) {
    toast("Open a folder first.", "info");
    return;
  }
  const name = window.prompt("New file path (relative to the project root)", "src/untitled.ts");
  if (!name) return;
  try {
    await api.createEntry(name, "file");
    await refreshTree();
    await openFile(name, { preview: true });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function pickFolder(): Promise<void> {
  try {
    const chosen = await pickDirectory();
    if (!chosen) return;
    await openWorkspace(chosen);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function createProject(): Promise<void> {
  const name = window.prompt("Project name", "my-project");
  if (!name) return;
  try {
    const base = await pickDirectory();
    if (!base) return;
    const root = `${base.replace(/\/+$/, "")}/${name.replace(/[^\w.-]/g, "-")}`;
    const subfolders = ["src", "tests", "public"];
    for (const sub of subfolders) {
      await api.createEntry(`${root}/${sub}`, "directory").catch(() => {});
    }
    await api.writeFile(`${root}/README.md`, `# ${name}\n\nCreated with Ducky Coder Lite.\n`);
    await api.writeFile(`${root}/.gitignore`, "node_modules/\ndist/\ntarget/\n*.log\n");
    await openWorkspace(root);
    toast(`Created ${name}.`, "success");
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function openWorkspace(path: string): Promise<void> {
  const result = await api.openFolder(path);
  store.update((s) => {
    s.workspace = { root: result.root, name: result.name };
    s.settings = result.settings;
    s.tabs = [];
    s.activeTabId = null;
    s.tree = null;
    s.closedTabs = [];
    s.problems = [];
    s.search.matches = [];
    s.search.query = "";
    s.activePanel = "explorer";
    s.sidebarVisible = true;
  });
  applySettingsToDom(result.settings);
  await refreshTree();
  // The tree's root row is the folder itself, already marked expanded.
  if (store.state.tree) store.state.tree.children = result.entries.map((e) => ({
    path: e.path,
    name: e.name,
    kind: e.kind,
    language: e.language,
    children: e.kind === "directory" ? null : [],
    expanded: false,
    size: e.size,
    hidden: e.isHidden,
    filteredChildren: e.hasFilteredChildren,
  }));
  store.notify();
  document.title = `${result.name} — Ducky Coder Lite`;
  // Open the first source file so the user lands in code, not in a blank pane.
  const first = await findFirstSource(result.entries);
  if (first) await openFile(first, { preview: true });
}

/**
 * Pick a file to open when a folder is opened, so the user lands in code rather
 * than in an empty pane.
 *
 * Tries the conventional entry points first, then falls back to a source file
 * inside a conventional source directory, then to any source file at all. A
 * project that uses none of the usual names still gets something sensible; the
 * alternative is a blank editor, which reads as a failure to start.
 */
async function findFirstSource(
  entries: { path: string; kind: string; name: string; language?: string }[],
): Promise<string | null> {
  const files = entries.filter((e) => e.kind === "file");
  if (files.length === 0) return null;

  const preferred = [
    "src/main.rs", "src/index.ts", "src/main.ts", "main.py", "index.js",
    "src/main.py", "main.go", "src/index.js", "main.c", "src/main.c",
    "index.html", "main.lua", "src/App.tsx", "src/app.ts",
  ];
  for (const p of preferred) {
    const hit = files.find((e) => e.path === p || e.path.endsWith("/" + p));
    if (hit) return hit.path;
  }

  const sourceish = new Set([
    "rust", "typescript", "javascript", "python", "go", "lua", "java",
    "c", "cpp", "csharp", "ruby", "php", "kotlin", "swift", "html", "shell",
  ]);
  const inSourceDir = files.find(
    (e) => /(^|\/)(src|lib|app|internal|pkg|cmd)\//.test(e.path) && sourceish.has(e.language ?? ""),
  );
  if (inSourceDir) return inSourceDir.path;

  const anySource = files.find((e) => sourceish.has(e.language ?? ""));
  if (anySource) return anySource.path;

  // Nothing looks like source at the top level: look one directory down, since
  // `src/` is where the interesting file almost always lives.
  const sourceDirs = entries.filter(
    (e) => e.kind === "directory" && /^(src|lib|app|internal|pkg|cmd|tests)$/.test(e.name),
  );
  for (const dir of sourceDirs) {
    const nested = await api.listDir(dir.path);
    const hit = nested.find((c) => c.kind === "file" && sourceish.has(c.language ?? ""));
    if (hit) return hit.path;
  }

  // Still nothing: open the first ordinary file.
  const any = files.find((e) => !e.name.startsWith("."));
  return any?.path ?? files[0]!.path;
}

function promptGotoLine(): void {
  const input = window.prompt("Go to line number:");
  if (!input) return;
  const line = Number(input.replace(/\D/g, ""));
  if (!Number.isFinite(line) || line < 1) return;
  editor!.goToLine(line);
}

function toggleWordWrap(): void {
  const settings = store.state.settings;
  if (!settings) return;
  const next = { ...settings, editor: { ...settings.editor, wordWrap: !settings.editor.wordWrap } };
  store.update((s) => {
    s.settings = next;
  });
  editor!.applySettings(next);
  void api.updateSettings(next);
  toast(next.editor.wordWrap ? "Word wrap on." : "Word wrap off.");
}

function zoom(delta: number): void {
  const current = Number(document.documentElement.style.getPropertyValue("--ui-zoom") || "1");
  const next = delta === 0 ? 1 : Math.max(0.7, Math.min(1.6, current + delta));
  document.documentElement.style.setProperty("--ui-zoom", String(next));
  // Scale the root font size rather than every component.
  document.documentElement.style.fontSize = `${(16 * next).toFixed(2)}px`;
  toast(`Zoom: ${Math.round(next * 100)}%`);
}

function formatDocument(): void {
  const settings = store.state.settings;
  if (!settings) return;
  const before = editor!.content;
  // A conservative, language-agnostic normaliser: strip trailing whitespace and
  // guarantee exactly one final newline. A real formatter per language would be
  // a dependency this app deliberately does not carry.
  let formatted = before
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");
  if (!formatted.endsWith("\n")) formatted += "\n";
  if (formatted === before) {
    toast("Already formatted.");
    return;
  }
  const path = editor!.path;
  openDiff({
    path,
    before,
    after: formatted,
    mode: "next",
    title: "Format Document",
    onAccept: (after) => {
      editor!.replaceAll(after);
      store.update((s) => {
        const tab = s.tabs.find((t) => t.path === path);
        if (tab) tab.dirty = true;
      });
    },
  });
}

function revealExternal(): void {
  const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId);
  if (!tab) return;
  window.dispatchEvent(new CustomEvent("ducky:reveal-external", { detail: tab.path }));
}

async function stageAll(): Promise<void> {
  const status = await api.gitStatus();
  const paths = status.entries.filter((e) => !e.staged).map((e) => e.path);
  if (paths.length === 0) {
    toast("Nothing to stage.", "info");
    return;
  }
  await api.gitStage(paths);
  refreshScm();
  toast(`Staged ${paths.length} file${paths.length === 1 ? "" : "s"}.`, "success");
}

async function unstageAll(): Promise<void> {
  const status = await api.gitStatus();
  const paths = status.entries.filter((e) => e.staged).map((e) => e.path);
  if (paths.length === 0) {
    toast("Nothing staged.", "info");
    return;
  }
  await api.gitUnstage(paths);
  refreshScm();
  toast(`Unstaged ${paths.length} file${paths.length === 1 ? "" : "s"}.`, "success");
}

function promptCommit(): void {
  showPanel("scm");
  const input = document.querySelector<HTMLInputElement>(".scm-commit-input");
  input?.focus();
}

async function gitAction(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const out = await fn();
    refreshScm();
    toast(typeof out === "string" && out.trim() ? out.trim().split("\n").slice(-2).join(" ") : `${label} done.`, "success");
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

function refreshScmQuietly(): void {
  // Only ask git about the world when the SCM view is actually open, so a normal
  // editing session never spawns a git process at all.
  if (store.state.activePanel === "scm" && store.state.sidebarVisible) refreshScm();
}

async function testAi(): Promise<void> {
  store.update((s) => {
    s.aiTesting = true;
  });
  try {
    const result = await api.aiTest();
    store.update((s) => {
      s.aiConnected = result.ok;
      s.aiTesting = false;
    });
    toast(result.message, result.ok ? "success" : "error");
  } catch (err) {
    store.update((s) => {
      s.aiConnected = false;
      s.aiTesting = false;
    });
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function toggleLowMemory(): Promise<void> {
  const settings = store.state.settings;
  if (!settings) return;
  const next: typeof settings = {
    ...settings,
    lowMemory: { ...settings.lowMemory, enabled: !settings.lowMemory.enabled },
  };
  store.update((s) => {
    s.settings = next;
  });
  applySettingsToDom(next);
  editor!.applySettings(next);
  await api.updateSettings(next);
  if (next.lowMemory.enabled) {
    store.releaseMemory(true);
    toast("Low Memory Mode on. Inactive tabs were suspended and caches trimmed.", "success");
  } else {
    toast("Low Memory Mode off.");
  }
}

function releaseMemoryNow(): void {
  store.releaseMemory(true);
  void readMemory().then(() => {
    const mem = store.state.mem;
    toast(
      mem
        ? `Released memory. Ducky Coder Lite is now using ${mem.appTotalMb.toFixed(0)} MB.`
        : "Memory released.",
      "success",
    );
  });
}

/** The AI composer: a bigger, plan-first prompt for larger changes. */
function openComposer(): void {
  if (composerOpen) return;
  composerOpen = true;

  const textarea = h("textarea", {
    class: "composer-input",
    rows: 6,
    placeholder:
      "Describe the feature you want. For example:\n\nCreate a dashboard with authentication and a settings page.",
    spellcheck: false,
  }) as HTMLTextAreaElement;

  const steps = h(
    "div",
    { class: "composer-steps" },
    ...[
      "Understand the request and plan the changes",
      "Retrieve only the files that matter",
      "Propose edits and show you every diff",
      "Run commands only if you approve them",
      "Apply the changes, then report what changed",
    ].map((s, i) =>
      h(
        "div",
        { class: "composer-step" },
        h("span", { class: "composer-step-num" }, String(i + 1)),
        h("span", null, s),
      ),
    ),
  );

  showModal(
    "Ducky AI Composer",
    h(
      "div",
      { class: "composer" },
      h(
        "p",
        { class: "composer-text" },
        "Describe a larger change. Ducky AI will plan it, retrieve only the relevant files, and show you a diff for every file before writing anything.",
      ),
      steps,
      textarea,
      h(
        "div",
        { class: "modal-actions" },
        h(
          "button",
          {
            class: "btn",
            onClick: () => {
              composerOpen = false;
              document.querySelector(".modal-overlay")?.remove();
            },
          },
          h("span", null, "Cancel"),
        ),
        h(
          "button",
          {
            class: "btn btn--primary",
            onClick: () => {
              const text = textarea.value.trim();
              composerOpen = false;
              document.querySelector(".modal-overlay")?.remove();
              if (!text) return;
              store.update((s) => {
                s.aiPanelVisible = true;
                s.agentMode = true;
                s.chatDraft = text;
              });
              // The chat panel picks this up on its next render.
              queueMicrotask(() => {
                const composer = document.querySelector<HTMLTextAreaElement>(".ai-composer");
                if (composer) {
                  composer.value = text;
                  composer.focus();
                }
              });
              toast("Composer sent to Ducky AI in agent mode.", "success");
            },
          },
          icons.sparkle(12),
          h("span", null, "Send to Ducky AI"),
        ),
      ),
    ),
  );
  textarea.focus();
}

function showShortcuts(): void {
  const seen = new Set<string>();
  const rows = DEFAULT_BINDINGS.filter((b) => {
    const sig = b.combo + b.label;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  showModal(
    "Keyboard Shortcuts",
    h(
      "div",
      { class: "shortcuts" },
      h(
        "div",
        { class: "shortcuts-grid" },
        ...rows.map((b) =>
          h(
            "div",
            { class: "shortcut-row" },
            h("span", { class: "shortcut-label" }, b.label),
            h("kbd", null, keyCombo(b.combo)),
          ),
        ),
      ),
      h(
        "p",
        { class: "modal-note" },
        "Find, replace, multi-cursor, folding and the rest of the editor's own shortcuts are handled inside the editor, as you would expect.",
      ),
    ),
  );
}

function showAbout(): void {
  const mem = store.state.mem;
  showModal(
    "About Ducky Coder Lite",
    h(
      "div",
      { class: "about" },
      h("div", { class: "about-mark" }, icons.duck(46)),
      h("h3", { class: "about-title" }, "Ducky Coder Lite"),
      h("div", { class: "about-tagline" }, "Code fast. Stay light."),
      h("p", { class: "about-version mono" }, `version ${appInfo?.version ?? "1.0.0"}`),
      h(
        "p",
        { class: "about-text" },
        "A lightweight AI coding environment engineered for 2 GB of RAM. AI inference runs on a provider you configure, context is retrieved on demand rather than indexed wholesale, and only the file you are looking at is ever parsed and rendered.",
      ),
      h(
        "div",
        { class: "about-facts mono" },
        h("div", null, `System: ${mem ? `${mem.systemTotalMb.toFixed(0)} MB` : "—"}`),
        h("div", null, `In use: ${mem ? `${mem.appTotalMb.toFixed(0)} MB` : "—"}`),
        h("div", null, `Uptime: ${appInfo ? formatUptime(appInfo.uptimeSeconds) : "—"}`),
        h("div", null, `Git: ${appInfo?.gitAvailable ? "available" : "not found"}`),
      ),
    ),
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Native folder picker.
 *
 * Uses the Tauri dialog plugin when it is available, and falls back to a
 * prompt otherwise. The fallback matters: it keeps the editor usable if the
 * native dialog cannot be created (a missing portal on a minimal Linux install,
 * for instance) rather than failing the one action a first-time user will try.
 */
async function pickDirectory(): Promise<string | null> {
  try {
    const picked = await openDialog({ directory: true, multiple: false, title: "Open Folder" });
    return typeof picked === "string" ? picked : null;
  } catch {
    const manual = window.prompt("Path to open:");
    return manual?.trim() ? manual.trim() : null;
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function onEvent(name: string, handler: (detail: unknown) => void): void {
  window.addEventListener(name, (e) => handler((e as CustomEvent).detail));
}

onEvent("ducky:command-palette", () => openCommandPalette(COMMANDS));
onEvent("ducky:quick-open", () => void openQuickOpen());
onEvent("ducky:toggle-ai", toggleAi);
onEvent("ducky:inline-ai", () => openInlineAi());
onEvent("ducky:composer", openComposer);
onEvent("ducky:toggle-sidebar", toggleSidebar);
onEvent("ducky:toggle-bottom", toggleBottom);
onEvent("ducky:toggle-terminal", toggleTerminal);
onEvent("ducky:toggle-problems", toggleProblems);
onEvent("ducky:focus-search", focusSearch);
onEvent("ducky:goto-line", promptGotoLine);
onEvent("ducky:save", () => void saveActive());
onEvent("ducky:save-all", () => void saveAll());
onEvent("ducky:close-tab", () => void closeActive());
onEvent("ducky:reopen-tab", () => void reopenClosedTab());
onEvent("ducky:new-file", () => void newFile());
onEvent("ducky:open-folder", () => void pickFolder());
onEvent("ducky:new-terminal", () => void createTerminal());
onEvent("ducky:clear-terminal", clearActiveTerminal);
onEvent("ducky:refresh-problems", () => readMemory());

onEvent("ducky:open-settings", (detail) =>
  openSettings(((detail as string) ?? "general") as Parameters<typeof openSettings>[0]),
);
onEvent("ducky:reveal", (detail) => {
  const d = detail as { path: string; line: number; column: number } | undefined;
  if (!d) return;
  void (async () => {
    if (!store.state.tabs.some((t) => t.path === d.path)) await openFile(d.path, { preview: true });
    // Wait for the document swap to land before scrolling to it.
    setTimeout(() => editor!.reveal(d.line, d.column), 60);
  })();
});
onEvent("ducky:reveal-in-explorer", (detail) => {
  const path = detail as string;
  showPanel("explorer");
  setTimeout(() => {
    const row = document.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(path)}"]`);
    row?.scrollIntoView({ block: "center" });
  }, 80);
});
onEvent("ducky:reveal-external", (detail) => revealInFileManager(detail as string));
onEvent("ducky:escape", () => {
  if (store.state.chatStreaming) {
    stopStreaming();
    return;
  }
  document.querySelector(".modal-overlay")?.remove();
  document.querySelector(".palette-overlay")?.remove();
  document.querySelector(".floating-menu")?.remove();
  document.querySelector(".inline-ai")?.remove();
});

onEvent("ducky:tab-index", (detail) => {
  const i = detail as number;
  const tab = store.state.tabs[i];
  if (tab) {
    store.update((s) => {
      s.activeTabId = tab.id;
    });
  }
});
onEvent("ducky:tab-cycle", (detail) => {
  const delta = detail as number;
  const tabs = store.state.tabs;
  if (tabs.length === 0) return;
  const current = tabs.findIndex((t) => t.id === store.state.activeTabId);
  const next = (current + delta + tabs.length) % tabs.length;
  store.update((s) => {
    s.activeTabId = tabs[next]!.id;
  });
});

// Context menu on the editor: the AI actions live where the selection is.
shell.editorHost.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest(".cm-editor")) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY, [
    { label: "Go to Definition (search)", icon: icons.search, run: () => focusSearch() },
    { label: "Go to Line…", icon: icons.arrowRight, run: promptGotoLine },
    { separator: true, label: "" },
    { label: "Ducky AI: Edit with AI", icon: icons.sparkle, run: () => openInlineAi() },
    { label: "Ducky AI: Explain", icon: icons.info, run: () => void runQuickAction("explain") },
    { label: "Ducky AI: Fix", icon: icons.bolt, run: () => void runQuickAction("fix") },
    { label: "Ducky AI: Refactor", icon: icons.edit, run: () => void runQuickAction("refactor") },
    { label: "Ducky AI: Generate Tests", icon: icons.check, run: () => void runQuickAction("tests") },
    { separator: true, label: "" },
    { label: "Format Document", icon: icons.edit, run: formatDocument },
    { label: "Copy Path", icon: icons.copy, run: () => {
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId);
      if (tab) void navigator.clipboard.writeText(tab.path);
    } },
  ]);
});

async function revealInFileManager(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch {
    toast("Could not open the system file manager.", "error");
  }
}

// ---------------------------------------------------------------------------
// Global key handling
// ---------------------------------------------------------------------------

for (const b of DEFAULT_BINDINGS) {
  keyboard.bind({
    combo: b.combo,
    label: b.label,
    globalOnly: b.globalOnly,
    allowInTerminal: b.allowInTerminal,
    run: (e) => {
      b.run(e);
      return true;
    },
  });
}

window.addEventListener(
  "keydown",
  (e) => {
    // `e.target` is not guaranteed to be an Element: a keydown dispatched at
    // the document or window level has a Document/Window target, and calling
    // `.closest()` on those throws. Treat "not an element" as "not in a
    // text field" rather than letting it take down the handler.
    const raw = e.target as unknown;
    const target = raw instanceof HTMLElement ? raw : null;
    const closest = (sel: string): boolean => !!target?.closest(sel);
    const inEditor = closest(".cm-editor");
    const terminalEl = outputElement();
    const active = document.activeElement;
    const inTerminal = !!terminalEl && (terminalEl === active || active === terminalEl);
    const inInput = closest("input, textarea, [contenteditable]") && target !== terminalEl;

    // Terminal input wins over everything except explicitly allowed bindings.
    if (inTerminal && !inInput) {
      if (e.key === "Escape") {
        store.update((s) => {
          s.bottomPanel = null;
        });
        return;
      }
      if (terminalKeyHandler(e)) return;
    }

    if (keyboard.handle(e, { inEditor, inTerminal, inInput })) return;

    // Escape in the editor clears the selection, which is CodeMirror's job.
  },
  true,
);

// ---------------------------------------------------------------------------
// Backend subscriptions
// ---------------------------------------------------------------------------

void on<MemEvent>("mem://snapshot", (evt) => {
  store.update((s) => {
    s.mem = evt.snapshot;
    s.pressure = evt.pressure;
    s.lowMemoryNotice = evt.message;
  });
  if (evt.message) toast(evt.message, "info");
  // The backend escalated: do the matching work here, now, rather than waiting
  // for the next unrelated event to notice.
  if (evt.pressure === "critical") {
    store.releaseMemory(true);
  } else if (evt.pressure === "elevated") {
    store.releaseMemory(false);
    void api.cancelSearch().catch(() => {});
  }
});

async function readMemory(): Promise<void> {
  try {
    const snap = await api.memSnapshot();
    store.update((s) => {
      s.mem = snap;
    });
  } catch {
    // The status bar simply keeps its last reading.
  }
}

// The editor's own problems feed the Problems panel. Collected on a timer so it
// never runs inside a keystroke.
window.setInterval(() => {
  const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId);
  if (!tab || tab.content === undefined) return;
  if (!editor || editor.path !== tab.path) return;
  try {
    const collected = collectProblems(editor);
    store.update((s) => {
      s.problems = collected;
    });
  } catch {
    // Never let diagnostics break the editor.
  }
}, 2000);

/**
 * Read the diagnostics CodeMirror's linter has already produced.
 *
 * `forceLinting` returns the current diagnostic set synchronously. We reuse it
 * rather than re-analysing, so this runs no work at all: it just copies what the
 * linter computed on its own debounce and hands it to the Problems panel.
 */
function collectProblems(host: EditorHost): State["problems"] {
  const path = host.path;
  if (!path) return [];

  let diagnostics: readonly { from: number; to: number; severity: string; message: string; source?: string }[] = [];
  try {
    diagnostics = forceLinting(host.view) ?? [];
  } catch {
    return [];
  }

  const doc = host.view.state.doc;
  const out: State["problems"] = [];
  for (const d of diagnostics) {
    const pos = Math.min(Math.max(0, d.from), doc.length);
    const line = doc.lineAt(pos);
    out.push({
      file: path,
      line: line.number,
      column: pos - line.from + 1,
      severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
      message: d.message,
      source: d.source ?? "Ducky",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let resizeObserver: ResizeObserver | null = null;
function observeResize(): void {
  const el = outputElement();
  if (!el) return;
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    resizeActive();
  });
  resizeObserver.observe(el);
}

window.addEventListener("resize", () => {
  resizeActive();
});

window.addEventListener("beforeunload", (e) => {
  const dirty = store.state.tabs.filter((t) => t.dirty);
  if (dirty.length > 0) {
    e.preventDefault();
    e.returnValue = `${dirty.length} unsaved file(s)`;
    return `${dirty.length} unsaved file(s)`;
  }
});

/**
 * Fallback settings.
 *
 * Only used if the backend has not answered yet, which happens when the frontend
 * is opened outside the app shell. Keeping a valid object here means the editor
 * can initialise without waiting for IPC.
 */
function fallbackSettings(): NonNullable<State["settings"]> {
  return {
    version: 1,
    lastWorkspace: null,
    recentWorkspaces: [],
    editor: {
      fontFamily: "ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.55,
      tabSize: 4,
      insertSpaces: true,
      wordWrap: false,
      minimap: false,
      lineNumbers: true,
      bracketMatching: true,
      formatOnSave: false,
      largeFileBytes: 1_500_000,
      hugeFileBytes: 8_000_000,
      renderLineLimit: 20_000,
      bracketPairColorization: true,
    },
    ai: {
      provider: {
        id: "ducky",
        label: "Ducky AI",
        kind: "ducky",
        baseUrl: "https://api.duckycoder.ai/v1",
        model: "",
        fastModel: "",
        hasKey: false,
        maxContextTokens: 24_000,
        maxOutputTokens: 4096,
        temperature: 0.2,
        extraHeaders: {},
      },
      autoContext: true,
      maxContextFiles: 8,
      maxFileChars: 24_000,
      autocompleteDebounceMs: 350,
      autocompleteEnabled: true,
      agentRequiresApproval: true,
      agentCanRunCommands: true,
      historyCharBudget: 120_000,
      historyMessageThreshold: 24,
    },
    terminal: {
      shell: IS_MAC ? "/bin/zsh" : "/bin/bash",
      args: [],
      cwd: "",
      scrollbackLines: 750,
      fontSize: 13,
      cursorBlink: true,
      copyOnSelect: false,
    },
    search: {
      excludeGlobs: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/target/**"],
      maxResults: 2000,
      maxFileBytes: 2_000_000,
      caseSensitive: false,
      useRegex: false,
      wholeWord: false,
    },
    lowMemory: {
      enabled: true,
      shedThresholdMb: 256,
      criticalThresholdMb: 128,
      suspendInactiveTabs: true,
      warmTabLimit: 3,
      maxRenderLines: 12_000,
      suspendLanguageServices: true,
      pauseBackgroundIndexing: true,
      maxSearchResults: 500,
      terminalScrollback: 300,
      showNotice: true,
    },
    showPerformanceIndicator: true,
    telemetry: false,
    openRecent: true,
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  // Paint the shell immediately, before any IPC round trip.
  store.notify();
  paint();

  installTerminal();
  // Subscribe to the AI token stream before the first message can be sent,
  // so no tokens are dropped.
  void installStreamListeners();

  try {
    appInfo = await api.appInfo();
  } catch (err) {
    if (err instanceof DuckyError) {
      // Running in a browser rather than the desktop shell. Say so once, clearly.
      store.update((s) => {
        s.settings = fallbackSettings();
        s.booted = true;
      });
      applySettingsToDom(store.state.settings!);
      paint();
      toast("Ducky Coder Lite must run in its desktop shell, not a browser.", "error");
      return;
    }
  }

  await loadSettings();
  editor!.applySettings(store.state.settings!);
  applyEditorVars(shell.editorHost, store.state.settings!);

  // Reopen the last project, if there was one.
  const last = store.state.settings?.lastWorkspace;
  if (last) {
    try {
      await openWorkspace(last);
    } catch {
      // The folder may have been deleted or be on an unmounted drive. Fall back
      // to the welcome screen rather than refusing to start.
      store.update((s) => {
        s.workspace = null;
        s.tree = null;
      });
    }
  }

  store.update((s) => {
    s.booted = true;
  });

  await readMemory();
  observeResize();
  refreshTabSignature();
}

function refreshTabSignature(): void {
  resetTabSignature();
  paint();
}

// Keep the tab strip's incremental rebuild honest when the tab set changes
// through a path other than a user gesture.
store.subscribe(() => {
  if (store.state.tabs.length) return;
  resetTabSignature();
});

void cursorChanged(1, 1);
void boot();
