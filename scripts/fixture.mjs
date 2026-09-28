/**
 * Shared mock backend used by the smoke test and the demo screenshot.
 *
 * It returns plausible data for every command the frontend calls, so the UI can
 * be driven without a compiled backend. It is a *fixture*, not a mock framework:
 * one handler per command, with a small realistic project.
 */

export const SETTINGS = {
  version: 1,
  lastWorkspace: "/demo-project",
  recentWorkspaces: [
    { path: "/demo-project", name: "demo-project", lastOpened: 1 },
    { path: "/notes", name: "notes", lastOpened: 0 },
  ],
  editor: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13, lineHeight: 1.55,
    tabSize: 4, insertSpaces: true, wordWrap: false, minimap: false,
    lineNumbers: true, bracketMatching: true, formatOnSave: false,
    largeFileBytes: 1500000, hugeFileBytes: 8000000, renderLineLimit: 20000,
    bracketPairColorization: true,
  },
  ai: {
    provider: {
      id: "ducky", label: "Ducky AI", kind: "ducky",
      baseUrl: "https://api.duckycoder.ai/v1", model: "ducky-coder",
      fastModel: "ducky-coder-fast", hasKey: true,
      maxContextTokens: 24000, maxOutputTokens: 4096, temperature: 0.2,
      extraHeaders: {},
    },
    autoContext: true, maxContextFiles: 8, maxFileChars: 24000,
    autocompleteDebounceMs: 350, autocompleteEnabled: true,
    agentRequiresApproval: true, agentCanRunCommands: true,
    historyCharBudget: 120000, historyMessageThreshold: 24,
  },
  terminal: {
    shell: "/bin/bash", args: [], cwd: "", scrollbackLines: 750,
    fontSize: 13, cursorBlink: true, copyOnSelect: false,
  },
  search: {
    excludeGlobs: ["**/node_modules/**", "**/.git/**"], maxResults: 2000,
    maxFileBytes: 2000000, caseSensitive: false, useRegex: false, wholeWord: false,
  },
  lowMemory: {
    enabled: true, shedThresholdMb: 256, criticalThresholdMb: 128,
    suspendInactiveTabs: true, warmTabLimit: 3, maxRenderLines: 12000,
    suspendLanguageServices: true, pauseBackgroundIndexing: true,
    maxSearchResults: 500, terminalScrollback: 300, showNotice: true,
  },
  showPerformanceIndicator: true, telemetry: false, openRecent: true,
};

export const RUST = `use std::collections::HashMap;
use crate::auth::{login, Credentials};

/// Entry point for the demo service.
fn main() {
    let mut registry: HashMap<String, u32> = HashMap::new();
    registry.insert("duck".to_string(), 1);
    println!("started with {} entries", registry.len());
}

fn authenticate(user: &str, password: &str) -> Result<(), String> {
    let creds = Credentials::new(user, password);
    login(&creds).map_err(|e| e.to_string())
}
`;

export const PY = `import hashlib

STUDED_HASHES = {}

def authenticate(user, password):
    """Check a password against the stored hash."""
    if not user:
        raise ValueError("user required")
    digest = hashlib.sha256(password.encode()).hexdigest()
    return digest == STORED_HASHES.get(user)
`;

const entry = (path, name, kind, language, size) => ({
  path, name, kind, size, language, isHidden: false, hasFilteredChildren: false,
  childDirCount: 0, childFileCount: 0,
});

export const HANDLERS = {
  app_info: () => ({
    name: "Ducky Coder Lite", tagline: "Code fast. Stay light.", version: "1.0.0",
    uptimeSeconds: 137, gitAvailable: true, shells: [["bash", "/bin/bash"]],
    lastWorkspace: "/demo-project", recentWorkspaces: SETTINGS.recentWorkspaces,
    secrets: { present: { ducky: true }, osKeystore: false }, pressure: "normal",
  }),
  get_settings: () => SETTINGS,
  mem_snapshot: () => ({
    processRssMb: 33.8, webviewRssMb: 121.4, appTotalMb: 155.2,
    systemUsedMb: 1102, systemTotalMb: 2048, systemAvailableMb: 946,
    swapUsedMb: 0, availableRatio: 0.46, threadCount: 16,
  }),
  open_folder: () => ({
    root: "/demo-project", name: "demo-project",
    entries: [
      entry("/demo-project/src", "src", "directory", "folder", 0),
      entry("/demo-project/tests", "tests", "directory", "folder", 0),
      entry("/demo-project/Cargo.toml", "Cargo.toml", "file", "toml", 210),
      entry("/demo-project/README.md", "README.md", "file", "markdown", 310),
    ],
    settings: SETTINGS,
  }),
  list_dir: (a) => {
    if (a.path === "/demo-project/src") {
      return [
        entry("/demo-project/src/main.rs", "main.rs", "file", "rust", RUST.length),
        entry("/demo-project/src/auth.py", "auth.py", "file", "python", PY.length),
        entry("/demo-project/src/lib.rs", "lib.rs", "file", "rust", 420),
      ];
    }
    if (a.path === "/demo-project/tests") {
      return [entry("/demo-project/tests/test_auth.py", "test_auth.py", "file", "python", 240)];
    }
    return [];
  },
  read_file: (a) => {
    const body = a.path.endsWith("main.rs") ? RUST
      : a.path.endsWith("auth.py") ? PY
      : a.path.endsWith("lib.rs") ? "pub fn helper() -> u32 {\n    42\n}\n"
      : a.path.endsWith(".toml")
        ? '[package]\nname = "demo-project"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n'
      : "# demo-project\n\nA small project for trying Ducky Coder Lite.\n";
    const lang = a.path.endsWith(".py") ? "python"
      : a.path.endsWith(".rs") ? "rust"
      : a.path.endsWith(".toml") ? "toml" : "markdown";
    return {
      path: a.path, content: body, truncated: false, large: false,
      size: body.length, language: lang, message: null, eol: "lf",
    };
  },
  git_status: () => ({
    isRepo: true, root: "/demo-project", branch: "main", upstream: "origin/main",
    ahead: 1, behind: 0, detached: false, hasConflicts: false,
    unavailableReason: null, message: null,
    entries: [
      { path: "src/auth.py", originalPath: null, status: "modified", staged: false, indexStatus: " ", worktreeStatus: "M" },
      { path: "src/lib.rs", originalPath: null, status: "untracked", staged: false, indexStatus: "?", worktreeStatus: "?" },
      { path: "README.md", originalPath: null, status: "added", staged: true, indexStatus: "A", worktreeStatus: " " },
    ],
  }),
  git_log: () => [
    { hash: "a1b2c3d", author: "Ada", relativeDate: "2 hours ago", subject: "Add login flow" },
    { hash: "9f8e7d6", author: "Ada", relativeDate: "yesterday", subject: "Initial commit" },
  ],
  git_branches: () => [["main", true], ["feature/auth", false]],
  terminal_create: () => ({ id: 1, title: "bash", cwd: "/demo-project" }),
  terminal_list: () => [{ id: 1, title: "bash", cwd: "/demo-project", alive: true }],
  ai_retrieve_context: () => ({
    files: [
      { path: "src/auth.py", reason: "matches your request", chars: 4800, tokens: 1200, partial: false },
      { path: "src/main.rs", reason: "imported by the code above", chars: 1600, tokens: 400, partial: true },
    ],
    totalTokens: 1600, truncated: false,
  }),
  quick_open: () => [
    { path: "src/main.rs", name: "main.rs", isDir: false, score: 900 },
    { path: "src/auth.py", name: "auth.py", isDir: false, score: 800 },
  ],
  search_workspace: () => ({
    matches: [
      { path: "src/auth.py", line: 6, column: 12, preview: "    digest = hashlib.sha256(password.encode()).hexdigest()", matchStart: 12, matchLength: 8, truncatedLine: false },
      { path: "src/main.rs", line: 3, column: 5, preview: "use crate::auth::{login, Credentials};", matchStart: 16, matchLength: 5, truncatedLine: false },
      { path: "src/main.rs", line: 14, column: 5, preview: "    login(&creds).map_err(|e| e.to_string())", matchStart: 4, matchLength: 5, truncatedLine: false },
    ],
    filesScanned: 214, truncated: false, elapsedMs: 24,
  }),
  secret_status: () => ({ present: { ducky: true }, osKeystore: false }),
  classify_command: () => ({ risk: "readOnly", requiresExplicitConfirmation: false }),
  ai_complete_task: () => "    Ok(())",
  ai_chat: () => "The `authenticate` function builds a `Credentials` value and hands it to `login`.\n\nOne thing worth flagging: `Credentials::new` is constructed without a `Result`, so a malformed username is silently accepted. Consider making it fallible.\n\n```path src/main.rs\n// proposed change\n```",
  apply_edits: () => [{ path: "src/main.rs", created: false, bytes: 420 }],
  ai_test: () => ({ ok: true, message: "Connected to Ducky AI (ducky-coder).", model: "ducky-coder", latencyMs: 210 }),
};
