/**
 * Typed bridge to the Rust backend.
 *
 * Every call goes through `invoke`, which is a single serialised round trip
 * over the Tauri IPC channel. Two rules keep this cheap:
 *
 *  1. Long-running work is not awaited on the UI thread. Search and AI return
 *     through events, and the promise here resolves when the *command* is
 *     accepted, not when all the data has arrived.
 *  2. Failures are normalised into `DuckyError` so callers never have to
 *     inspect a raw string, and so a cancelled operation is distinguishable
 *     from a failed one.
 */

type Handler = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
};

let bridge: Handler | null = null;

export function initBridge(): void {
  // Tauri v2 injects these on `window.__TAURI_INTERNALS__` in production and
  // via the npm package in dev. We resolve whichever is present.
  const w = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    __TAURI__?: {
      core: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      event: { listen: (e: string, cb: (p: unknown) => void) => Promise<() => void> };
    };
  };

  const invoke = w.__TAURI__?.core.invoke ?? w.__TAURI_INTERNALS__?.invoke;
  const listen = w.__TAURI__?.event.listen;

  if (!invoke || !listen) {
    // Running outside the desktop shell (e.g. `vite dev` in a plain browser).
    // The UI still renders; every command fails with a clear message instead of
    // hanging, which is much easier to debug than a silent no-op.
    bridge = {
      invoke: async () => {
        throw new DuckyError("other", "Not running inside the Ducky Coder Lite app shell.");
      },
      listen: async () => () => {},
    };
    return;
  }

  bridge = {
    invoke: invoke as Handler["invoke"],
    listen: listen as Handler["listen"],
  };
}

export class DuckyError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
    this.name = "DuckyError";
  }
  get cancelled(): boolean {
    return this.kind === "cancelled";
  }
}

/** Invoke a backend command, normalising errors. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!bridge) initBridge();
  try {
    return (await bridge!.invoke<T>(cmd, args)) as T;
  } catch (err) {
    if (err instanceof DuckyError) throw err;
    const any = err as { kind?: string; message?: string } | string;
    if (typeof any === "string") throw new DuckyError("other", any);
    throw new DuckyError(any?.kind ?? "other", any?.message ?? String(err));
  }
}

/** Subscribe to a backend event. Returns an unsubscribe function. */
export async function on<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!bridge) initBridge();
  return bridge!.listen<T>(event, cb);
}

// ---------------------------------------------------------------------------
// Wire types (mirrors of the Rust structs)
// ---------------------------------------------------------------------------

export type EntryKind = "file" | "directory" | "symlink";

export interface FsEntry {
  path: string;
  name: string;
  kind: EntryKind;
  size: number;
  modified: number;
  language: string;
  isHidden: boolean;
  hasFilteredChildren: boolean;
  childDirCount: number;
  childFileCount: number;
}

export interface MemSnapshot {
  processRssMb: number;
  webviewRssMb: number;
  appTotalMb: number;
  systemUsedMb: number;
  systemTotalMb: number;
  systemAvailableMb: number;
  swapUsedMb: number;
  availableRatio: number;
  threadCount: number;
}

export type Pressure = "normal" | "elevated" | "critical";

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchLength: number;
  truncatedLine: boolean;
}

export interface SearchResponse {
  matches: SearchMatch[];
  filesScanned: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface NameHit {
  path: string;
  name: string;
  isDir: boolean;
  score: number;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "clean";

export interface StatusEntry {
  path: string;
  originalPath: string | null;
  status: FileStatus;
  staged: boolean;
  indexStatus: string | null;
  worktreeStatus: string | null;
}

export interface RepoStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  entries: StatusEntry[];
  hasConflicts: boolean;
  unavailableReason: string | null;
  message: string | null;
}

export interface DiffPayload {
  path: string;
  staged: boolean;
  patch: string;
  isBinary: boolean;
  additions: number;
  deletions: number;
  oldPath: string | null;
  error: string | null;
}

export interface CommitInfo {
  hash: string;
  author: string;
  relativeDate: string;
  subject: string;
}

export type ProviderKind = "ducky" | "openAicompatible" | "ollama" | "localServer";

export interface AiProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  fastModel: string;
  hasKey: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  temperature: number;
  extraHeaders: Record<string, string>;
}

export interface AiConfig {
  provider: AiProviderConfig;
  autoContext: boolean;
  maxContextFiles: number;
  maxFileChars: number;
  autocompleteDebounceMs: number;
  autocompleteEnabled: boolean;
  agentRequiresApproval: boolean;
  agentCanRunCommands: boolean;
  historyCharBudget: number;
  historyMessageThreshold: number;
}

export interface EditorConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  bracketMatching: boolean;
  formatOnSave: boolean;
  largeFileBytes: number;
  hugeFileBytes: number;
  renderLineLimit: number;
  bracketPairColorization: boolean;
}

export interface TerminalConfig {
  shell: string;
  args: string[];
  cwd: string;
  scrollbackLines: number;
  fontSize: number;
  cursorBlink: boolean;
  copyOnSelect: boolean;
}

export interface SearchConfig {
  excludeGlobs: string[];
  maxResults: number;
  maxFileBytes: number;
  caseSensitive: boolean;
  useRegex: boolean;
  wholeWord: boolean;
}

export interface LowMemoryConfig {
  enabled: boolean;
  shedThresholdMb: number;
  criticalThresholdMb: number;
  suspendInactiveTabs: boolean;
  warmTabLimit: number;
  maxRenderLines: number;
  suspendLanguageServices: boolean;
  pauseBackgroundIndexing: boolean;
  maxSearchResults: number;
  terminalScrollback: number;
  showNotice: boolean;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

export interface Settings {
  version: number;
  lastWorkspace: string | null;
  recentWorkspaces: RecentWorkspace[];
  editor: EditorConfig;
  ai: AiConfig;
  terminal: TerminalConfig;
  search: SearchConfig;
  lowMemory: LowMemoryConfig;
  showPerformanceIndicator: boolean;
  telemetry: boolean;
  openRecent: boolean;
}

export interface ContextFile {
  path: string;
  reason: string;
  chars: number;
  tokens: number;
  partial: boolean;
}

export interface RetrievedContext {
  files: ContextFile[];
  totalTokens: number;
  truncated: boolean;
}

export type ChatRole = "system" | "user" | "assistant" | "context";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

export interface AppInfo {
  name: string;
  tagline: string;
  version: string;
  uptimeSeconds: number;
  gitAvailable: boolean;
  shells: [string, string][];
  lastWorkspace: string | null;
  recentWorkspaces: RecentWorkspace[];
  secrets: { present: Record<string, boolean>; osKeystore: boolean };
  pressure: Pressure;
}

export interface OpenFolderResult {
  root: string;
  name: string;
  entries: FsEntry[];
  settings: Settings;
}

export interface FileContents {
  path: string;
  content?: string;
  truncated?: boolean;
  large?: boolean;
  binary?: boolean;
  refused?: boolean;
  size: number;
  language: string;
  message?: string | null;
  eol?: "lf" | "crlf";
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface PtyDataEvent {
  channel: number;
  data: string;
}

export interface PtyExitEvent {
  channel: number;
  code: number;
}

export interface TermInfo {
  id: number;
  title: string;
  cwd: string;
  alive: boolean;
}

export interface ProposedEdit {
  path: string;
  content: string;
  create: boolean;
}

export interface ApplyResult {
  path: string;
  created: boolean;
  bytes: number;
}

export interface TestResult {
  ok: boolean;
  message: string;
  model: string;
  latencyMs: number;
}

export interface MemEvent {
  pressure: Pressure;
  label: string;
  message: string | null;
  snapshot: MemSnapshot;
}

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  getSettings: () => call<Settings>("get_settings"),
  updateSettings: (settings: Settings) => call<Settings>("update_settings", { settings }),
  setSecret: (provider: string, key: string) => call<unknown>("set_secret", { provider, key }),
  clearSecret: (provider: string) => call<unknown>("clear_secret", { provider }),
  secretStatus: () => call<unknown>("secret_status"),

  memSnapshot: () => call<MemSnapshot>("mem_snapshot"),
  openFolder: (path: string) => call<OpenFolderResult>("open_folder", { path }),
  closeFolder: () => call<void>("close_folder"),
  listDir: (path: string) => call<FsEntry[]>("list_dir", { path }),
  readFile: (path: string) => call<FileContents>("read_file", { path }),
  writeFile: (path: string, content: string) =>
    call<{ path: string; bytes: number }>("write_file", { path, content }),
  createEntry: (path: string, kind: EntryKind) => call<FsEntry>("create_entry", { path, kind }),
  renameEntry: (from: string, to: string) => call<string>("rename_entry", { from, to }),
  deleteEntry: (path: string) => call<void>("delete_entry", { path }),
  moveEntry: (from: string, toDir: string) => call<string>("move_entry", { from, toDir }),

  cancelSearch: () => call<void>("cancel_search"),
  searchWorkspace: (
    query: string,
    opts: {
      useRegex?: boolean;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      includePattern?: string | null;
      maxResults?: number;
    } = {},
  ) =>
    call<SearchResponse>("search_workspace", {
      query,
      useRegex: opts.useRegex ?? null,
      caseSensitive: opts.caseSensitive ?? null,
      wholeWord: opts.wholeWord ?? null,
      includePattern: opts.includePattern ?? null,
      maxResults: opts.maxResults ?? null,
    }),
  quickOpen: (query: string, limit = 60) => call<NameHit[]>("quick_open", { query, limit }),

  gitStatus: () => call<RepoStatus>("git_status"),
  gitDiff: (path: string, staged: boolean) => call<DiffPayload>("git_diff", { path, staged }),
  gitStage: (paths: string[]) => call<void>("git_stage", { paths }),
  gitUnstage: (paths: string[]) => call<void>("git_unstage", { paths }),
  gitDiscard: (path: string) => call<void>("git_discard", { path }),
  gitCommit: (message: string) => call<string>("git_commit", { message }),
  gitBranches: () => call<[string, boolean][]>("git_branches"),
  gitCheckout: (branch: string) => call<void>("git_checkout", { branch }),
  gitCreateBranch: (name: string) => call<void>("git_create_branch", { name }),
  gitPull: () => call<string>("git_pull"),
  gitPush: () => call<string>("git_push"),
  gitInit: () => call<void>("git_init"),
  gitLog: (limit = 50) => call<CommitInfo[]>("git_log", { limit }),

  terminalCreate: (rows = 24, cols = 80) =>
    call<{ id: number; title: string; cwd: string }>("terminal_create", { rows, cols }),
  terminalWrite: (id: number, data: string) => call<void>("terminal_write", { id, data }),
  terminalResize: (id: number, rows: number, cols: number) =>
    call<void>("terminal_resize", { id, rows, cols }),
  terminalKill: (id: number) => call<void>("terminal_kill", { id }),
  terminalList: () => call<TermInfo[]>("terminal_list"),
  runCommand: (command: string, args: string[]) =>
    call<CommandResult>("run_command", { command, args }),
  classifyCommand: (command: string) =>
    call<{ risk: string; requiresExplicitConfirmation: boolean }>("classify_command", { command }),

  aiTest: () => call<TestResult>("ai_test"),
  aiCancel: (request: string) => call<void>("ai_cancel", { request }),
  aiCancelAll: () => call<void>("ai_cancel_all"),
  aiRetrieveContext: (query: string, hints: string[], pinned: string[]) =>
    call<RetrievedContext>("ai_retrieve_context", { query, hints, pinned }),
  aiCompleteTask: (
    request: string,
    instruction: string,
    selection: string,
    filePath: string | null,
    useFastModel = false,
  ) => call<string>("ai_complete_task", { request, instruction, selection, filePath, useFastModel }),
  aiChat: (
    request: string,
    history: ChatMessage[],
    userMessage: string,
    pinned: string[],
    agentMode: boolean,
  ) => call<string>("ai_chat", { request, history, userMessage, pinned, agentMode }),
  applyEdits: (edits: ProposedEdit[], approved: boolean) =>
    call<ApplyResult[]>("apply_edits", { edits, approved }),
};
