/**
 * Boot smoke test.
 *
 * Loads the *built* bundle into a real DOM (jsdom), with a stubbed Tauri bridge,
 * and reports what the app actually produced. This catches the class of bug a
 * type-checker cannot: a module that throws during evaluation, a layout that
 * renders nothing, or a panel that never mounts.
 *
 *   node scripts/smoke.mjs
 *
 * Exit code 0 means the app booted and laid out. It is a boot check, not a
 * pixel check: it cannot tell you whether the result looks right, only that it
 * renders.
 */

import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const ASSETS = join(DIST, "assets");

// ---------------------------------------------------------------------------
// Stub backend
// ---------------------------------------------------------------------------

const SETTINGS = {
  version: 1,
  lastWorkspace: "/demo-project",
  recentWorkspaces: [
    { path: "/demo-project", name: "demo-project", lastOpened: 1 },
    { path: "/notes", name: "notes", lastOpened: 0 },
  ],
  editor: {
    fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.55,
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

const RUST = [
  "use std::collections::HashMap;",
  "",
  "/// Entry point for the demo service.",
  "fn main() {",
  "    let mut registry: HashMap<String, u32> = HashMap::new();",
  '    registry.insert("duck".to_string(), 1);',
  '    println!("started with {} entries", registry.len());',
  "}",
  "",
  "fn login(user: &str, password: &str) -> Result<(), String> {",
  '    if password.is_empty() {',
  '        return Err("password required".into());',
  "    }",
  "    Ok(())",
  "}",
].join("\n");

const PY = [
  "import hashlib",
  "",
  "def authenticate(user, password):",
  '    """Check a password against the stored hash."""',
  "    if not user:",
  '        raise ValueError("user required")',
  "    digest = hashlib.sha256(password.encode()).hexdigest()",
  "    return digest == STORED.get(user)",
].join("\n");

const entry = (path, name, kind, language, size) => ({
  path, name, kind, size, language, isHidden: false, hasFilteredChildren: false,
  childDirCount: 0, childFileCount: 0,
});

const HANDLERS = {
  app_info: () => ({
    name: "Ducky Coder Lite", tagline: "Code fast. Stay light.", version: "1.0.0",
    uptimeSeconds: 42, gitAvailable: true, shells: [["bash", "/bin/bash"]],
    lastWorkspace: "/demo-project", recentWorkspaces: SETTINGS.recentWorkspaces,
    secrets: { present: { ducky: true }, osKeystore: false }, pressure: "normal",
  }),
  get_settings: () => SETTINGS,
  mem_snapshot: () => ({
    processRssMb: 31.4, webviewRssMb: 118.2, appTotalMb: 149.6,
    systemUsedMb: 1024, systemTotalMb: 2048, systemAvailableMb: 1024,
    swapUsedMb: 0, availableRatio: 0.5, threadCount: 14,
  }),
  open_folder: () => ({
    root: "/demo-project", name: "demo-project",
    entries: [
      entry("/demo-project/src", "src", "directory", "folder", 0),
      entry("/demo-project/src/main.rs", "main.rs", "file", "rust", RUST.length),
      entry("/demo-project/Cargo.toml", "Cargo.toml", "file", "toml", 210),
      entry("/demo-project/README.md", "README.md", "file", "markdown", 310),
    ],
    settings: SETTINGS,
  }),
  list_dir: (a) =>
    a.path === "/demo-project/src"
      ? [
          entry("/demo-project/src/main.rs", "main.rs", "file", "rust", RUST.length),
          entry("/demo-project/src/auth.py", "auth.py", "file", "python", PY.length),
        ]
      : [],
  read_file: (a) => {
    const body = a.path.endsWith("main.rs") ? RUST
      : a.path.endsWith("auth.py") ? PY
      : "# demo\n\nHello from Ducky Coder Lite.\n";
    return {
      path: a.path, content: body, truncated: false, large: false,
      size: body.length, language: "rust", message: null, eol: "lf",
    };
  },
  git_status: () => ({
    isRepo: true, root: "/demo-project", branch: "main", upstream: "origin/main",
    ahead: 1, behind: 0, detached: false, hasConflicts: false,
    unavailableReason: null, message: null,
    entries: [
      { path: "src/auth.py", originalPath: null, status: "modified", staged: false, indexStatus: " ", worktreeStatus: "M" },
      { path: "src/main.rs", originalPath: null, status: "untracked", staged: false, indexStatus: "?", worktreeStatus: "?" },
      { path: "README.md", originalPath: null, status: "added", staged: true, indexStatus: "A", worktreeStatus: " " },
    ],
  }),
  git_log: () => [
    { hash: "a1b2c3d", author: "Ada", relativeDate: "2 hours ago", subject: "Add login flow" },
    { hash: "9f8e7d6", author: "Ada", relativeDate: "yesterday", subject: "Initial commit" },
  ],
  terminal_create: () => ({ id: 1, title: "bash", cwd: "/demo-project" }),
  terminal_list: () => [],
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
  search_workspace: () => ({ matches: [], filesScanned: 12, truncated: false, elapsedMs: 8 }),
  secret_status: () => ({ present: { ducky: true }, osKeystore: false }),
  classify_command: () => ({ risk: "readOnly", requiresExplicitConfirmation: false }),
};

const invoke = (cmd, args) => Promise.resolve((HANDLERS[cmd] ?? (() => null))(args ?? {}));
const listen = () => Promise.resolve(() => {});

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const problems = [];
const vc = new VirtualConsole();
for (const level of ["jsdomError", "error"]) {
  vc.on(level, (...a) => problems.push(`${level}: ${a.map(String).join(" ")}`));
}

const dom = new JSDOM(readFileSync(join(DIST, "index.html"), "utf8"), {
  url: "http://localhost/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
});

const W = dom.window;
W.__TAURI__ = { core: { invoke }, event: { listen } };

// jsdom implements no layout and no rendering, so the handful of APIs the app
// measures against are stubbed here. The application code is left untouched.
W.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
W.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const SIZES = {
  clientWidth: 1200, clientHeight: 600, offsetWidth: 1200, offsetHeight: 22,
  scrollHeight: 600, scrollWidth: 1200, scrollTop: 0, scrollLeft: 0,
  clientTop: 0, clientLeft: 0, offsetTop: 0, offsetLeft: 0, tabIndex: 0,
};
for (const [prop, value] of Object.entries(SIZES)) {
  if (!Object.getOwnPropertyDescriptor(W.HTMLElement.prototype, prop)?.get) {
    Object.defineProperty(W.HTMLElement.prototype, prop, { get: () => value, configurable: true });
  }
}
W.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 22,
  width: 1200, height: 22, toJSON() {},
});
// CodeMirror measures text with Range.getClientRects, which jsdom does not
// implement. A flat rectangle per rect is enough for it to lay out.
const flatRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
if (W.Range) {
  W.Range.prototype.getClientRects = function () { return [flatRect]; };
  W.Range.prototype.getBoundingClientRect = function () { return flatRect; };
}
W.HTMLElement.prototype.setSelectionRange = () => {};
W.HTMLElement.prototype.focus = () => {};
W.HTMLElement.prototype.blur = () => {};

// Install the window as the module-scope environment.
for (const key of Object.getOwnPropertyNames(W)) {
  if (key in globalThis) continue;
  try {
    globalThis[key] = W[key];
  } catch {
    /* some window props are getter-only; skipping them is fine */
  }
}
globalThis.window = W;
globalThis.document = W.document;
globalThis.self = W;
globalThis.navigator ??= W.navigator;

// The app talks to its backend only through the Tauri `invoke` bridge, so a
// network request here means something reached for `fetch` directly. Log it
// rather than letting it fail the run, so the boot can continue and be
// inspected.
const fetches = [];
const fakeFetch = (input) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  fetches.push(url);
  return Promise.resolve({
    ok: true, status: 200, statusText: "OK",
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
    headers: new Map(),
  });
};
if (!URL.canParse || URL.canParse("http://x")) {
  W.fetch = fakeFetch;
  globalThis.fetch = fakeFetch;
}
for (const name of ["ResizeObserver", "IntersectionObserver", "matchMedia", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "CustomEvent", "KeyboardEvent",
  "MouseEvent", "MutationObserver", "Node", "Element", "HTMLElement", "DOMParser",
  "Text", "Range", "NodeFilter", "DocumentFragment", "CSS"]) {
  if (W[name] !== undefined) globalThis[name] = W[name];
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const chunk = readdirSync(ASSETS).find((f) => /^index-.*\.js$/.test(f));
if (!chunk) {
  console.error("no entry chunk in dist/assets — run the frontend build first");
  process.exit(2);
}

const t0 = Date.now();
try {
  await import(pathToFileURL(join(ASSETS, chunk)).href);
} catch (e) {
  problems.push(`boot threw: ${e.message}`);
  if (e.stack) problems.push(e.stack.split("\n").slice(1, 5).join("\n"));
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(250);
await settle(350);
await settle(500);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const doc = W.document;
const $ = (s) => doc.querySelector(s);
const $$ = (s) => doc.querySelectorAll(s);
const lines = [];
const say = (s = "") => lines.push(s);

say(`boot: ${Date.now() - t0} ms`);
say();

if (problems.length) {
  say(`!! ${problems.length} runtime problem(s):`);
  for (const p of problems.slice(0, 5)) say(`   ${p}`);
  say();
} else {
  say("no runtime errors");
  say();
}

const CHECKS = [
  ["#app > .shell", "app shell mounted"],
  [".activity-bar", "activity bar"],
  [".activity-item", "activity buttons"],
  [".sidebar", "sidebar"],
  [".sidebar-title", "sidebar header"],
  [".tab-strip", "tab strip"],
  [".tab", "open tabs"],
  [".editor-host .cm-editor", "CodeMirror instance"],
  [".cm-line", "rendered editor lines"],
  [".cm-gutters", "line-number gutter"],
  [".status-bar", "status bar"],
  [".status-item", "status items"],
];

let hardFail = problems.length > 0;
say("layout:");
for (const [sel, label] of CHECKS) {
  const n = $$(sel).length;
  if (n === 0) hardFail = true;
  say(`  ${n > 0 ? "ok  " : "MISS"} ${label.padEnd(26)} ${n}`);
}

say();
say("activity bar:");
for (const b of $$(".activity-item")) say(`  - ${b.getAttribute("aria-label")}`);

if ($$(".tab").length) {
  say();
  say("tabs:");
  for (const t of $$(".tab")) {
    say(`  ${(t.querySelector(".tab-name")?.textContent ?? "?").padEnd(16)} ${t.className}`);
  }
}

if ($$(".tree-row").length) {
  say();
  say("explorer:");
  for (const r of $$(".tree-row")) {
    say(`  ${(r.querySelector(".tree-name")?.textContent ?? "?").padEnd(16)} ${r.className}`);
  }
}

if ($$(".status-item").length) {
  say();
  say("status bar:");
  for (const s of $$(".status-item")) {
    const text = s.textContent.trim().replace(/\s+/g, " ");
    say(`  ${text || s.getAttribute("title") || "(icon)"}`);
  }
}

const cmLines = $$(".cm-line");
if (cmLines.length) {
  say();
  say(`editor content (${cmLines.length} lines rendered):`);
  for (const l of [...cmLines].slice(0, 8)) {
    const text = l.textContent.replace(/\u00a0/g, " ");
    if (text.trim()) say(`  | ${text}`);
  }
  // Highlighted spans are the proof that a grammar actually loaded and parsed.
  const spans = $$(".cm-line span");
  say();
  say(`  highlight spans: ${spans.length}`);
  const classes = new Set([...spans].map((s) => s.className).filter(Boolean));
  say(`  distinct token classes: ${classes.size}`);
}

console.log(lines.join("\n"));
process.exit(hardFail ? 1 : 0);
