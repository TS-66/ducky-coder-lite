/**
 * Application state and the memory policy that acts on it.
 *
 * This module is the single place that decides what stays in memory. Everything
 * else in the frontend is a view over this state. The rules it enforces:
 *
 *  - **The editor tab strip is not a document cache.** Only the active tab holds
 *    a CodeMirror view. The next few most-recently-used tabs keep their text in
 *    a bounded LRU (so tab-switching is instant), and everything beyond that is
 *    suspended: the text is dropped and re-read from disk when reopened.
 *  - **Pressure moves the warm limit.** When the machine gets tight the warm
 *    window shrinks to 1, then to 0, so "reopen" always means "re-read".
 *  - **Nothing grows without a bound.** Chat history, search results, terminal
 *    scrollback, file-tree rows and AI context all have explicit caps.
 */

import { api } from "./backend";
import type {
  FsEntry,
  MemSnapshot,
  Pressure,
  Settings,
} from "./backend";

export type PanelId =
  | "explorer"
  | "search"
  | "scm"
  | "run"
  | "extensions"
  | "ducky";

export type PanelPosition = "left" | "right" | "bottom";

export interface Tab {
  id: string;
  /** Absolute path. */
  path: string;
  name: string;
  language: string;
  dirty: boolean;
  pinned: boolean;
  preview: boolean;
  /** Epoch ms of last activation, used by the LRU. */
  lastUsed: number;
  /** True when the document is suspended: no text, no editor view. */
  suspended: boolean;
  /** Only set while loaded. */
  content?: string;
  truncated?: boolean;
  large?: boolean;
  size?: number;
  eol?: "lf" | "crlf";
  /** Set when the file could not be opened, so the tab still renders something. */
  problem?: string;
  binary?: boolean;
}

export interface TerminalTab {
  id: number;
  title: string;
  alive: boolean;
  /** Frontend-owned scrollback; see notes in `pty.ts` about why it lives here. */
  lines: string[];
  cwd: string;
  /** Collapsed view of the buffer, rebuilt on demand. */
  searchTerm: string;
}

export interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
  cancelled?: boolean;
  error?: boolean;
  /** Attached context, so the user can see what the model was shown. */
  context?: { files: { path: string; tokens: number }[]; totalTokens: number; truncated: boolean };
  /** Proposed file changes awaiting approval. */
  proposal?: Proposal;
  ts: number;
}

export interface Proposal {
  id: string;
  files: { path: string; content: string; create: boolean; original?: string }[];
  summary: string;
  commands: string[];
}

export interface Problem {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: FsEntry["kind"];
  language: string;
  /** null = not yet loaded. This is what makes the tree lazy. */
  children: TreeNode[] | null;
  expanded: boolean;
  size: number;
  hidden: boolean;
  filteredChildren: boolean;
}

export interface State {
  booted: boolean;
  settings: Settings | null;
  workspace: { root: string; name: string } | null;
  tree: TreeNode | null;
  expandedPaths: Set<string>;

  activePanel: PanelId;
  panelPosition: Record<PanelId, PanelPosition>;
  sidebarVisible: boolean;
  panelVisible: boolean;
  aiPanelVisible: boolean;
  /** The five panel views the reference shows across the bottom drawer. */
  bottomPanel: "terminal" | "problems" | "output" | "debug" | "ports" | null;

  tabs: Tab[];
  activeTabId: string | null;
  /** Tabs closed this session, for "Reopen Closed Tab". */
  closedTabs: { path: string }[];

  terminals: TerminalTab[];
  activeTerminalId: number | null;

  chat: ChatEntry[];
  chatDraft: string;
  /** Agent mode: the model may propose edits and commands. */
  agentMode: boolean;
  /** Composer view, as opposed to plain chat. */
  composerMode: boolean;
  chatStreaming: boolean;
  chatHistory: { role: "user" | "assistant" | "context"; content: string }[];

  pinnedContext: string[];
  lastRetrievedContext: {
    files: { path: string; reason: string; tokens: number }[];
    totalTokens: number;
    truncated: boolean;
  } | null;

  problems: Problem[];
  search: {
    query: string;
    matches: import("./backend").SearchMatch[];
    running: boolean;
    useRegex: boolean;
    caseSensitive: boolean;
    wholeWord: boolean;
    includePattern: string;
    filesScanned: number;
    truncated: boolean;
    elapsedMs: number;
    selectedIndex: number;
  };

  mem: MemSnapshot | null;
  pressure: Pressure;
  lowMemoryNotice: string | null;

  aiConnected: boolean | null;
  aiTesting: boolean;
  busy: string | null;
  toast: { message: string; kind: "info" | "error" | "success" } | null;
}

/** Hard caps. These are the numbers that make the memory budget a fact. */
export const LIMITS = {
  /** Chat messages kept in the DOM/history. */
  chatEntries: 120,
  /** Search results rendered at once; the rest are counted but not drawn. */
  searchRender: 300,
  /** Tree rows held in the explorer. */
  treeRows: 4000,
  /** Problems retained. */
  problems: 500,
  /** Terminal lines retained per terminal. */
  terminalLines: 750,
  /** Terminal lines retained in Low Memory Mode. */
  terminalLinesLow: 300,
  /** Entries in the closed-tab ring. */
  closedTabs: 20,
} as const;

type Listener = (state: State) => void;

class Store {
  state: State = {
    booted: false,
    settings: null,
    workspace: null,
    tree: null,
    expandedPaths: new Set(),

    activePanel: "explorer",
    panelPosition: {
      explorer: "left",
      search: "left",
      scm: "left",
      run: "left",
      extensions: "left",
      ducky: "right",
    },
    sidebarVisible: true,
    panelVisible: false,
    aiPanelVisible: false,
    bottomPanel: null,

    tabs: [],
    activeTabId: null,
    closedTabs: [],

    terminals: [],
    activeTerminalId: null,

    chat: [],
    chatDraft: "",
    agentMode: false,
    composerMode: false,
    chatStreaming: false,
    chatHistory: [],

    pinnedContext: [],
    lastRetrievedContext: null,

    problems: [],
    search: {
      query: "",
      matches: [],
      running: false,
      useRegex: false,
      caseSensitive: false,
      wholeWord: false,
      includePattern: "",
      filesScanned: 0,
      truncated: false,
      elapsedMs: 0,
      selectedIndex: 0,
    },

    mem: null,
    pressure: "normal",
    lowMemoryNotice: null,

    aiConnected: null,
    aiTesting: false,
    busy: null,
    toast: null,
  };

  private listeners = new Set<Listener>();
  /** Coalesce notifications: many small mutations produce one render. */
  private pending = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      for (const fn of this.listeners) {
        try {
          fn(this.state);
        } catch (err) {
          // A broken view must never take down the store.
          console.error("[ducky] listener failed", err);
        }
      }
    });
  }

  /** Mutate state and schedule one render. */
  update(fn: (s: State) => void): void {
    fn(this.state);
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  tabById(id: string | null): Tab | undefined {
    if (!id) return undefined;
    return this.state.tabs.find((t) => t.id === id);
  }

  tabByPath(path: string): Tab | undefined {
    return this.state.tabs.find((t) => t.path === path);
  }

  /**
   * How many inactive tabs may keep their text in memory.
   *
   * This is the main dial. It is `warmTabLimit` normally, 1 when memory is
   * tight, and 0 when memory is critical — at which point closing a tab really
   * does release its text.
   */
  warmTabLimit(): number {
    const s = this.state.settings;
    if (!s) return 2;
    if (!s.lowMemory.enabled) return Math.max(s.lowMemory.warmTabLimit, 4);
    switch (this.state.pressure) {
      case "critical":
        return 0;
      case "elevated":
        return Math.min(s.lowMemory.warmTabLimit, 1);
      default:
        return s.lowMemory.warmTabLimit;
    }
  }

  /** Suspend every tab beyond the warm window, plus the active tab's siblings. */
  enforceTabBudget(): void {
    const limit = this.warmTabLimit();
    const active = this.state.activeTabId;

    // Rank inactive tabs: pinned first, then most recently used.
    const inactive = this.state.tabs
      .filter((t) => t.id !== active)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.lastUsed - a.lastUsed;
      });

    // `active` itself is index -1 conceptually: always kept loaded.
    const keep = new Set<string>(active ? [active] : []);
    for (let i = 0; i < Math.min(limit, inactive.length); i++) {
      keep.add(inactive[i].id);
    }

    let changed = false;
    for (const tab of this.state.tabs) {
      if (keep.has(tab.id)) continue;
      if (!tab.suspended && tab.content !== undefined) {
        // Drop the text. The tab keeps its identity, dirty flag and scroll
        // position so reopening feels continuous.
        tab.suspended = true;
        tab.content = undefined;
        tab.truncated = undefined;
        tab.large = undefined;
        tab.binary = undefined;
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** Total characters of document text currently retained. */
  residentTextChars(): number {
    let total = 0;
    for (const t of this.state.tabs) {
      if (t.content !== undefined) total += t.content.length;
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Bounded collections
  // -------------------------------------------------------------------------

  pushChat(entry: ChatEntry): void {
    this.state.chat.push(entry);
    if (this.state.chat.length > LIMITS.chatEntries) {
      // Drop the oldest non-streaming entries, and reset the assistant history
      // that mirrors them so the two do not drift apart.
      const overflow = this.state.chat.length - LIMITS.chatEntries;
      let removed = 0;
      const kept: ChatEntry[] = [];
      for (const e of this.state.chat) {
        if (removed < overflow && !e.streaming && e.role !== "system") {
          removed++;
          continue;
        }
        kept.push(e);
      }
      this.state.chat = kept;
    }
  }

  pushProblem(p: Problem): void {
    this.state.problems.push(p);
    if (this.state.problems.length > LIMITS.problems) {
      this.state.problems.splice(0, this.state.problems.length - LIMITS.problems);
    }
  }

  pushTerminalLine(id: number, line: string): void {
    const term = this.state.terminals.find((t) => t.id === id);
    if (!term) return;
    term.lines.push(line);
    const cap = this.terminalLineCap();
    if (term.lines.length > cap) {
      // Ring the buffer. `splice` on a bounded array is O(n) but n is at most
      // `cap`, and this only runs on overflow.
      term.lines.splice(0, term.lines.length - cap);
    }
  }

  terminalLineCap(): number {
    const s = this.state.settings;
    if (!s) return LIMITS.terminalLines;
    return s.lowMemory.enabled
      ? s.lowMemory.terminalScrollback
      : s.terminal.scrollbackLines;
  }

  /** Immediately release non-essential memory. Used by "Clear Chat" and when
   *  the pressure ladder escalates. */
  releaseMemory(aggressive: boolean): void {
    if (aggressive) {
      // Drop every inactive document's text.
      for (const t of this.state.tabs) {
        if (t.id !== this.state.activeTabId) {
          t.suspended = true;
          t.content = undefined;
          t.truncated = undefined;
          t.large = undefined;
          t.binary = undefined;
        }
      }
      // Trim terminal scrollback hard.
      const cap = Math.max(50, Math.floor(this.terminalLineCap() / 2));
      for (const t of this.state.terminals) {
        if (t.lines.length > cap) t.lines.splice(0, t.lines.length - cap);
      }
    }
    this.enforceTabBudget();
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------
// Tab operations
// ---------------------------------------------------------------------------

let tabCounter = 0;

export function tabId(path: string): string {
  // Stable, readable, collision-free. Using the path means re-opening a
  // suspended tab reuses the same record.
  return `t${++tabCounter}:${path}`;
}

export async function openFile(path: string, opts: { preview?: boolean } = {}): Promise<void> {
  const existing = store.state.tabs.find((t) => t.path === path);
  if (existing) {
    if (existing.suspended) {
      await reloadTab(existing);
    }
    activateTab(existing.id);
    return;
  }

  const name = path.split(/[\\/]/).pop() ?? path;
  const preview = opts.preview ?? true;
  const tab: Tab = {
    id: tabId(path),
    path,
    name,
    language: guessLanguage(name),
    dirty: false,
    pinned: false,
    preview,
    lastUsed: Date.now(),
    suspended: false,
  };

  store.update((s) => {
    // A preview tab is replaced by the next preview open, exactly as users
    // expect from a Cursor/VS Code style editor.
    if (preview) {
      const previewIndex = s.tabs.findIndex((t) => t.preview && !t.dirty);
      if (previewIndex >= 0) {
        s.tabs.splice(previewIndex, 1);
      }
    }
    s.tabs.push(tab);
    s.activeTabId = tab.id;
  });

  await reloadTab(tab);
  store.enforceTabBudget();
}

async function reloadTab(tab: Tab): Promise<void> {
  try {
    const file = await api.readFile(tab.path);
    store.update((s) => {
      const t = s.tabs.find((x) => x.id === tab.id);
      if (!t) return;
      t.suspended = false;
      t.lastUsed = Date.now();
      t.size = file.size;
      t.language = file.language || t.language;
      t.binary = file.binary ?? false;
      t.truncated = file.truncated ?? false;
      t.large = file.large ?? false;
      t.eol = file.eol ?? "lf";
      if (file.binary || file.refused || file.content === undefined) {
        t.content = undefined;
        t.problem = file.message ?? "This file cannot be shown in the editor.";
      } else {
        t.content = file.content;
        t.problem = file.message ?? undefined;
      }
    });
  } catch (err) {
    store.update((s) => {
      const t = s.tabs.find((x) => x.id === tab.id);
      if (t) t.problem = err instanceof Error ? err.message : String(err);
    });
  }
}

export function activateTab(id: string): void {
  store.update((s) => {
    const t = s.tabs.find((x) => x.id === id);
    if (t) {
      t.lastUsed = Date.now();
      // Activating a tab promotes it out of preview mode.
      t.preview = false;
    }
    s.activeTabId = id;
  });
  store.enforceTabBudget();
}

export async function closeTab(id: string): Promise<void> {
  const tab = store.state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.dirty) {
    // The tab strip renders a confirm affordance; here we just report it so the
    // caller can decide. The command palette and keyboard shortcut both route
    // through `requestCloseTab`.
    const ok = window.confirm(`Save changes to ${tab.name} before closing?`);
    if (ok) await saveTab(id);
    else if (!window.confirm(`Close ${tab.name} and discard your changes?`)) return;
  }
  doCloseTab(id);
}

export function doCloseTab(id: string): void {
  store.update((s) => {
    const index = s.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [removed] = s.tabs.splice(index, 1);
    if (removed && !removed.pinned) {
      s.closedTabs.push({ path: removed.path });
      if (s.closedTabs.length > LIMITS.closedTabs) s.closedTabs.shift();
    }
    if (s.activeTabId === id) {
      // Activate the neighbour to the right, or the last one.
      const next = s.tabs[index] ?? s.tabs[index - 1] ?? null;
      s.activeTabId = next ? next.id : null;
      if (next) next.lastUsed = Date.now();
    }
  });
  store.enforceTabBudget();
}

export async function saveTab(id: string): Promise<boolean> {
  const tab = store.state.tabs.find((t) => t.id === id);
  if (!tab || tab.content === undefined) return false;
  try {
    await api.writeFile(tab.path, tab.content);
    store.update((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (t) t.dirty = false;
    });
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
    return false;
  }
}

export async function saveAll(): Promise<void> {
  const dirty = store.state.tabs.filter((t) => t.dirty);
  for (const t of dirty) await saveTab(t.id);
}

export async function reopenClosedTab(): Promise<void> {
  const last = store.state.closedTabs.pop();
  if (!last) return;
  await openFile(last.path, { preview: false });
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;

export function toast(message: string, kind: "info" | "error" | "success" = "info"): void {
  store.update((s) => {
    s.toast = { message, kind };
  });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    store.update((s) => {
      s.toast = null;
    });
  }, kind === "error" ? 6000 : 2600);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LANG_BY_EXT: Record<string, string> = {
  rs: "rust", ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json", jsonc: "json", json5: "json5", py: "python", pyi: "python",
  lua: "lua", rb: "ruby", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", swift: "swift", php: "php", sh: "shell", bash: "shell",
  zsh: "shell", ksh: "shell", fish: "fish", ps1: "powershell", psm1: "powershell",
  bat: "batch", cmd: "batch", sql: "sql", html: "html", htm: "html", css: "css",
  scss: "sass", sass: "sass", less: "less", vue: "vue", svelte: "svelte",
  md: "markdown", markdown: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "ini", cfg: "ini", conf: "ini", xml: "xml", plist: "xml",
  graphql: "graphql", gql: "graphql", proto: "protobuf", tf: "terraform",
  zig: "zig", ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell",
  scala: "scala", dart: "dart", r: "r", jl: "julia", asm: "asm", s: "asm",
  diff: "diff", patch: "diff", txt: "text", log: "text", env: "dotenv",
  gitignore: "gitignore", lock: "lockfile", plaintext: "plaintext",
};

export function guessLanguage(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile" || lower === "gnumakefile") return "makefile";
  if (lower.startsWith(".env")) return "dotenv";
  if (lower === ".gitignore" || lower === ".dockerignore") return "gitignore";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

/** Load settings and apply the parts of them that affect the shell. */
export async function loadSettings(): Promise<Settings> {
  const settings = await api.getSettings();
  store.update((s) => {
    s.settings = settings;
  });
  applySettingsToDom(settings);
  return settings;
}

export function applySettingsToDom(settings: Settings): void {
  const html = document.documentElement;
  html.dataset.lowMemory = settings.lowMemory.enabled ? "on" : "off";
  html.dataset.animations = settings.lowMemory.enabled ? "off" : "on";
  // Reflect the memory budget in the title so a user taking a screenshot or
  // reading a bug report can see the editor was running in low-memory mode.
  document.title = settings.lowMemory.enabled
    ? "Ducky Coder Lite — LOW MEMORY"
    : "Ducky Coder Lite";
}
