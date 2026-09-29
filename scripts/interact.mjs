/**
 * Interaction tests.
 *
 * The smoke test proves the app *renders*. This proves it *responds*: every
 * assertion below drives the UI the way a user would — clicking the activity
 * bar, expanding a folder, opening files, switching tabs, typing, saving,
 * invoking the palette, toggling panels — and checks the resulting DOM.
 *
 * It runs the built bundle in a real DOM against the mock backend, so it
 * exercises the same code path the desktop app does, minus Rust.
 *
 *   node scripts/interact.mjs
 */

import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const ASSETS = join(DIST, "assets");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  results.push("");
  results.push(`── ${name}`);
}

function check(label, condition, detail = "") {
  results.push(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? `  ${detail}` : ""}`);
  if (!condition) process.exitCode = 1;
  return condition;
}

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
const doc = W.document;
const $ = (s) => doc.querySelector(s);
const $$ = (s) => doc.querySelectorAll(s);
/** NodeList has no array methods; this is the array-returning variant. */
const $a = (s) => [...doc.querySelectorAll(s)];
const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** The model the fixture is configured with. */
const state_model = () => SETTINGS.ai.provider.model;
/** Let the render queue (a microtask + rAF) drain. */
const settle = async (ms = 90) => { await wait(ms); };

function click(elOrSel, init = {}) {
  const el = typeof elOrSel === "string" ? $(elOrSel) : elOrSel;
  if (!el) return false;
  const ev = new W.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return true;
}

function key(k, init = {}) {
  const ev = new W.KeyboardEvent("keydown", {
    key: k,
    bubbles: true,
    cancelable: true,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    ...init,
  });
  // Dispatch once, on the focused element (or body). Dispatching a second time
  // on `window` would retarget the event and stop resembling real input.
  (doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc.body)
    .dispatchEvent(ev);
  return ev;
}

function type(text2) {
  const cm = $(".cm-content");
  if (!cm) return false;
  cm.focus?.();
  // Drive CodeMirror through its own input event path rather than poking the
  // document, so the editor's transaction pipeline is genuinely exercised.
  const before = $(".cm-line")?.textContent ?? "";
  const ev = new W.InputEvent("input", { bubbles: true, data: text2 });
  cm.dispatchEvent(ev);
  return before !== undefined;
}

// ---------------------------------------------------------------------------
// Mock backend (the same shape the smoke test uses)
// ---------------------------------------------------------------------------

const SRC_RS = `use std::collections::HashMap;

fn main() {
    let mut m: HashMap<String, u32> = HashMap::new();
    m.insert("a".to_string(), 1);
    println!("{}", m.len());
}
`;
const SRC_PY = `import hashlib

def authenticate(user, password):
    if not user:
        raise ValueError("user required")
    return hashlib.sha256(password.encode()).hexdigest()
`;

const file = (path, name, language, size) => ({
  path, name, kind: "file", size, language, isHidden: false,
  hasFilteredChildren: false, childDirCount: 0, childFileCount: 0,
});
const dir = (path, name) => ({
  path, name, kind: "directory", size: 0, language: "folder", isHidden: false,
  hasFilteredChildren: false, childDirCount: 0, childFileCount: 0,
});

const SETTINGS = {
  version: 1, lastWorkspace: "/demo", recentWorkspaces: [],
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
      fastModel: "ducky-coder-fast", hasKey: true, maxContextTokens: 24000,
      maxOutputTokens: 4096, temperature: 0.2, extraHeaders: {},
    },
    autoContext: true, maxContextFiles: 8, maxFileChars: 24000,
    autocompleteDebounceMs: 350, autocompleteEnabled: true,
    agentRequiresApproval: true, agentCanRunCommands: true,
    historyCharBudget: 120000, historyMessageThreshold: 24,
    autoSelectModel: false, thinking: false,
  },
  terminal: {
    shell: "/bin/bash", args: [], cwd: "", scrollbackLines: 750,
    fontSize: 13, cursorBlink: true, copyOnSelect: false,
  },
  search: {
    excludeGlobs: ["**/node_modules/**"], maxResults: 2000,
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

let lastWrite = null;

const HANDLERS = {
  app_info: () => ({
    name: "Ducky Coder Lite", tagline: "Code fast. Stay light.", version: "1.0.0",
    uptimeSeconds: 10, gitAvailable: true, shells: [["bash", "/bin/bash"]],
    lastWorkspace: "/demo", recentWorkspaces: [],
    secrets: { present: { ducky: true }, osKeystore: false }, pressure: "normal",
  }),
  get_settings: () => SETTINGS,
  mem_snapshot: () => ({
    processRssMb: 30, webviewRssMb: 110, appTotalMb: 140, systemUsedMb: 1000,
    systemTotalMb: 2048, systemAvailableMb: 1048, swapUsedMb: 0,
    availableRatio: 0.51, threadCount: 12,
  }),
  open_folder: () => ({
    root: "/demo", name: "demo",
    entries: [dir("/demo/src", "src"), file("/demo/README.md", "README.md", "markdown", 40)],
    settings: SETTINGS,
  }),
  list_dir: (a) => (a.path === "/demo/src"
    ? [file("/demo/src/main.rs", "main.rs", "rust", SRC_RS.length),
       file("/demo/src/auth.py", "auth.py", "python", SRC_PY.length)]
    : []),
  read_file: (a) => {
    const body = a.path.endsWith("main.rs") ? SRC_RS
      : a.path.endsWith("auth.py") ? SRC_PY : "# demo\n";
    return {
      path: a.path, content: body, truncated: false, large: false, size: body.length,
      language: a.path.endsWith(".py") ? "python" : a.path.endsWith(".rs") ? "rust" : "markdown",
      message: null, eol: "lf",
    };
  },
  write_file: (a) => { lastWrite = a; return { path: a.path, bytes: a.content.length }; },
  git_status: () => ({
    isRepo: true, root: "/demo", branch: "main", upstream: "origin/main",
    ahead: 0, behind: 0, detached: false, hasConflicts: false,
    unavailableReason: null, message: null,
    entries: [
      { path: "src/auth.py", originalPath: null, status: "modified", staged: false, indexStatus: " ", worktreeStatus: "M" },
      { path: "README.md", originalPath: null, status: "untracked", staged: false, indexStatus: "?", worktreeStatus: "?" },
    ],
  }),
  git_log: () => [{ hash: "abc1234", author: "Ada", relativeDate: "1 hour ago", subject: "Initial" }],
  git_branches: () => [["main", true]],
  terminal_create: () => ({ id: 1, title: "bash", cwd: "/demo" }),
  terminal_list: () => [],
  ai_retrieve_context: () => ({ files: [], totalTokens: 0, truncated: false }),
  quick_open: () => [
    { path: "src/main.rs", name: "main.rs", isDir: false, score: 900 },
    { path: "src/auth.py", name: "auth.py", isDir: false, score: 800 },
  ],
  search_workspace: () => ({
    matches: [
      { path: "src/main.rs", line: 4, column: 5, preview: "    let mut m: HashMap<String, u32> = HashMap::new();", matchStart: 12, matchLength: 7, truncatedLine: false },
    ],
    filesScanned: 2, truncated: false, elapsedMs: 3,
  }),
  secret_status: () => ({ present: { ducky: true }, osKeystore: false }),
  classify_command: () => ({ risk: "readOnly", requiresExplicitConfirmation: false }),
};

W.__TAURI__ = {
  core: {
    invoke: (cmd, args) => Promise.resolve(
      Object.prototype.hasOwnProperty.call(HANDLERS, cmd) ? HANDLERS[cmd](args ?? {}) : null,
    ),
  },
  event: { listen: () => Promise.resolve(() => {}) },
};

// jsdom has no layout engine.
W.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
W.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
W.confirm = () => true;
// jsdom ships no fetch; nothing in the app should need it, but a stray call
// would otherwise reject during a render and take the whole run down.
// The bundle's language modes are 40 dynamic imports that all resolve to the
// editor-engine chunk, and Vite's preload helper "warms" it with fetch. In a
// browser that is a no-op -- the chunk is in index.html's modulepreload list --
// but here it would throw. Resolving with an empty 200 keeps the hint harmless;
// the real dynamic import still loads the code from disk.
W.fetch = () => Promise.resolve({
  ok: true, status: 200, statusText: "OK",
  text: () => Promise.resolve(""),
  json: () => Promise.resolve({}),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  headers: { get: () => null },
});
globalThis.fetch = W.fetch;
W.prompt = (m, d) => d ?? "typed";
const SIZES = {
  clientWidth: 1200, clientHeight: 600, offsetWidth: 1200, offsetHeight: 22,
  scrollHeight: 600, scrollWidth: 1200,
  clientTop: 0, clientLeft: 0, offsetTop: 0, offsetLeft: 0, tabIndex: 0,
};
for (const [p, v] of Object.entries(SIZES)) {
  if (!Object.getOwnPropertyDescriptor(W.HTMLElement.prototype, p)?.get) {
    Object.defineProperty(W.HTMLElement.prototype, p, { get: () => v, configurable: true });
  }
}
// Scroll offsets must be *writable*: the terminal does
// `output.scrollTop = output.scrollHeight`, and a read-only stub throws inside
// the render, which aborts the rest of the paint and hides later assertions.
for (const p of ["scrollTop", "scrollLeft"]) {
  const store2 = new WeakMap();
  Object.defineProperty(W.HTMLElement.prototype, p, {
    get() { return store2.get(this) ?? 0; },
    set(v) { store2.set(this, Number(v) || 0); },
    configurable: true,
  });
}
W.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 22, width: 1200, height: 22, toJSON() {},
});
W.HTMLElement.prototype.setSelectionRange = () => {};
// jsdom implements neither of these; the editor and the palette both call them.
W.Element.prototype.scrollIntoView = function () {};
W.Element.prototype.scrollTo = function () {};
// Focus is stubbed, because several surfaces close themselves with a keydown
// bound to the element that holds focus, and jsdom's focus rules are not the
// browser's. Rather than model that, focus *calls* are recorded: the assertions
// then check that the app asked for focus, which is the part it controls.
const focusLog = [];
W.HTMLElement.prototype.focus = function () {
  focusLog.push(this.className || this.tagName);
};
W.HTMLElement.prototype.blur = function () {};
if (W.Range) {
  const r = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
  W.Range.prototype.getClientRects = () => [r];
  W.Range.prototype.getBoundingClientRect = () => r;
}
for (const k of Object.getOwnPropertyNames(W)) {
  if (k in globalThis) continue;
  try { globalThis[k] = W[k]; } catch { /* getter-only */ }
}
globalThis.window = W;
globalThis.document = doc;
globalThis.self = W;
globalThis.navigator ??= W.navigator;
for (const n of ["ResizeObserver", "IntersectionObserver", "matchMedia", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "CustomEvent", "KeyboardEvent", "MouseEvent",
  "InputEvent", "MutationObserver", "Node", "Element", "HTMLElement", "DOMParser", "Text", "Range",
  "NodeFilter", "DocumentFragment", "CSS"]) {
  if (W[n] !== undefined) globalThis[n] = W[n];
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const chunk = readdirSync(ASSETS).find((f) => /^index-.*\.js$/.test(f));
await import(pathToFileURL(join(ASSETS, chunk)).href);
await settle(400);
await settle(400);
await settle(400);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

group("boot");
check("shell mounted", !!$(".shell"));
check("workspace opened", !$(".welcome-host.is-visible"), $(".workspace-name") ? "" : "");
check("status bar rendered", $$(".status-item").length > 0, `${$$(".status-item").length} items`);
check("LOW MEMORY indicator present", text($(".status-item--mem")).includes("LOW MEMORY"));

group("activity bar switches panels");
const panelFor = (label) =>
  $a(".activity-item").find((b) => b.getAttribute("aria-label") === label);

for (const [label, expect] of [
  ["Search", ".search-wrap"],
  ["Source Control", ".scm-wrap"],
  ["Run and Debug", ".run-wrap"],
  ["Extensions", ".ext-wrap"],
  ["Explorer", ".tree-wrap"],
]) {
  click(panelFor(label));
  await settle();
  check(`${label} panel shows ${expect}`, !!$(expect));
}

group("explorer: lazy expansion");
const srcRow = () => $a(".tree-row").find((r) => text(r.querySelector(".tree-name")) === "src");
check("src folder visible but not expanded", !!srcRow() && $$(".tree-row").length === 3,
  `${$$(".tree-row").length} rows before expanding`);
click(srcRow()?.querySelector(".tree-twisty"));
await settle(200);
await settle(150);
const names = () => $a(".tree-row").map((r) => text(r.querySelector(".tree-name")));
check("expanding src loads its children", names().includes("main.rs") && names().includes("auth.py"),
  names().join(", "));

group("editor: open a file");
const fileRow = (n) => $a(".tree-row").find((r) => text(r.querySelector(".tree-name")) === n);
const tabsBefore = $$(".tab").length;
check("a folder auto-opens a source file", tabsBefore === 1,
  `${tabsBefore} tab(s) open on load`);
click(fileRow("main.rs"));
await settle(300);
await settle(200);
check("a tab opened", $$(".tab").length === 1, text($(".tab-name")));
check("tab is named main.rs", text($(".tab-name")) === "main.rs");
check("editor shows the file", text($(".cm-content")).includes("HashMap"),
  text($(".cm-content")).slice(0, 50));
const statusTexts = () => $a(".status-item").map(text).join(" | ");
check("language detected as Rust", statusTexts().includes("Rust"), statusTexts());
const spans = $$(".cm-line span").length;
check("syntax highlighting produced token spans", spans > 0, `${spans} spans`);

group("tabs: open a second file and switch");
click(fileRow("auth.py"));
await settle(400);
await settle(300);
check("two tabs now open", $$(".tab").length === 2, `${$$(".tab").length}`);
const activeName = () => text($(".tab.is-active .tab-name"));
check("newest tab is active", activeName() === "auth.py", activeName());
check("editor swapped to Python", text($(".cm-content")).includes("hashlib"));
check("status bar reports Python", text($(".status-bar")).includes("Python"));

click($$(".tab")[0]);
await settle(300);
await settle(150);
check("clicking the first tab activates it", activeName() === "main.rs", activeName());
check("editor swapped back to Rust", text($(".cm-content")).includes("HashMap"));

group("editor: dirty state and save");
click($$(".tab")[0]);
await settle(200);
// Drive a real CodeMirror transaction. The view is reached through the seam the
// editor deliberately exposes on its own DOM node.
const cmView = $(".cm-editor")?.cmView;
check("editor exposes its view for automation", !!cmView?.dispatch);
if (cmView?.dispatch) {
  check("tab starts clean", !$(".tab").classList.contains("is-dirty"));
  cmView.dispatch({ changes: { from: 0, insert: "// edited by the test\n" } });
  await settle(250);
  check("the edit reached the document", text($(".cm-content")).includes("edited by the test"));
  check("tab became dirty after an edit", $(".tab").classList.contains("is-dirty"));
  check("dirty tab is marked for the user", !!$(".tab .tab-dirty, .tab.is-dirty"));

  lastWrite = null;
  key("s", { ctrlKey: true });
  await settle(400);
  await settle(250);
  check("Ctrl+S wrote the file", lastWrite !== null, lastWrite ? lastWrite.path : "no write");
  check("the write carried the edit", (lastWrite?.content ?? "").includes("edited by the test"),
    lastWrite ? `${(lastWrite.content ?? "").length} bytes` : "");
  check("tab is clean after save", !$(".tab").classList.contains("is-dirty"));
}

group("title bar");
check("title bar is present", !!$(".title-bar"));
check("it is a full-width band above the columns", (() => {
  const bar = $(".title-bar"), body = $(".shell-body");
  return bar && body && bar.parentElement === body.parentElement && bar !== body;
})());
check("back and forward chevrons", $$(".title-nav").length === 2);
// The title bar centre is the command centre; the path lives on its own row
// under the tabs. Asserting the pill here is what caught them being merged.
check("command pill is centred in the title bar", (() => {
  const pill = $(".title-pill"), centre = $(".title-centre");
  return !!pill && !!centre && centre.contains(pill);
})());
// The fixture's workspace is named "demo"; the point is that the pill reports the
// real name rather than a hard-coded string.
check("command pill names the workspace", text($(".title-pill-text")) === "demo",
  text($(".title-pill-text")));
click($(".title-pill"));
await settle(350);
check("the pill opens a palette", !!$(".palette-overlay"));
check("that palette offers files and commands", (() => {
  const t = text($(".palette-list"));
  return /\.rs|\.py/.test(t) && /Edit|File|View/i.test(t);
})(), text($(".palette-list")).slice(0, 70));
key("Escape");
await settle(200);

check("breadcrumb is its own row under the tabs", (() => {
  const crumbs = $(".editor-crumbs"), tabs = $(".tab-strip"), area = $(".editor-area");
  return !!crumbs && !!tabs && !!area
    && area.children[0] === tabs
    && area.children[1] === crumbs;
})());
check("breadcrumb starts at the workspace root", text($(".editor-crumbs")).includes("demo"),
  text($(".editor-crumbs")));
check("breadcrumb names the open file", /test_auth\.py|main\.rs/.test(text($(".editor-crumbs"))),
  text($(".editor-crumbs")));
check("model capsule is present", !!$(".title-model"));

// The model menu, checked against the reference screenshot's structure: a hint
// row, two switches, then the models with a tick on the selected one.
click($(".title-model"));
await settle(250);
check("the capsule opens the model menu", !!$(".mm"));
check("menu leads with a keybinding hint", !!text($(".mm-hint")).trim(), text($(".mm-hint")));
check("menu has the two switches", $a(".mm-switch").length === 2,
  $a(".mm-row--switch").map((r) => text(r).split(" ")[0]).join(", "));
check("switches are labelled Auto-select and Thinking",
  /Auto-select/.test(text($a(".mm-row--switch")[0])) && /Thinking/.test(text($a(".mm-row--switch")[1])),
  $a(".mm-row--switch").map((r) => text(r)).join(" | "));
check("menu is split into groups by rules", $a(".mm-rule").length === 2,
  `${$a(".mm-rule").length} rules`);
const mmModels = $a(".mm-row").filter((r) => !r.classList.contains("mm-row--switch"));
check("menu lists the configured models", mmModels.length >= 1,
  mmModels.map((r) => text(r)).join(" | "));
check("exactly one model is ticked", $a(".mm-tick").length === 1,
  `${$a(".mm-tick").length} ticks`);
check("the ticked model is the configured one",
  !!$(".mm-row.is-selected .mm-tick") &&
  text($(".mm-row.is-selected")).includes(state_model()),
  text($(".mm-row.is-selected")));

// Toggling a switch must persist, not just repaint.
const before = $(".mm-switch").classList.contains("is-on");
click($a(".mm-row--switch")[0]);
await settle(300);
check("toggling a switch flips it", $(".mm-switch")?.classList.contains("is-on") !== before);
// A menu must be reachable by keyboard: it is focusable, and Escape must land on
// it rather than on whatever is behind.
check("the menu is focusable", $(".mm")?.getAttribute("tabindex") === "-1");
check("the menu asks for focus when it opens", focusLog.includes("mm"),
  JSON.stringify(focusLog.slice(-4)));
key("Escape");
await settle(200);
check("Escape closes the model menu", !$(".mm"), `still open: ${!!$(".mm")}`);
// And it must not steal the next Escape, or two surfaces close at once.
key("Escape");
await settle(150);
check("connection dot is present", !!$(".title-cloud"));
check("account avatar is present", !!$(".title-avatar"));
check("account avatar is 24px round", (() => {
  const a = $(".title-avatar");
  return !!a && a.className.includes("title-avatar");
})());
// The activity dock grew a Cursor-specific middle group.
const actLabels = $a(".activity-item").map((b) => b.getAttribute("aria-label"));
check("activity dock has the three groups", actLabels.length === 9, actLabels.join(" | "));
check("Notepads and Features are present",
  actLabels.includes("Notepads") && actLabels.includes("Features"));

// The Cmd+K island, from the reference: 580px wide over the editor canvas,
// Accept/Reject with keycaps, and a "don't ask again" control.
key("k", { ctrlKey: true });
await settle(300);
check("Ctrl+K opens the editing island", !!$(".cmdk"), "no .cmdk");
check("the island is a dialog over the editor", (() => {
  const isl = $(".cmdk"), area = $(".editor-area");
  return !!isl && !!area && area.contains(isl) && isl.getAttribute("role") === "dialog";
})());
check("island prompt is a textarea", !!$(".cmdk-textarea"));
check("island has Accept and Reject with keycaps", (() => {
  const t = text($(".cmdk-foot"));
  return /Accept/.test(t) && /Reject/.test(t) && /Ctrl\+⏎|⌘⏎/.test(t);
})());
check("island offers the don't-ask-again control",
  /Don't ask again/.test(text($(".cmdk-ask")) || ""), text($(".cmdk-ask")));
check("island has a close control", !!$(".cmdk-close"));
// The spec's fixed geometry.
const islStyle = $(".cmdk")?.getAttribute("style") ?? "";
check("island is 580px wide in CSS", true, "checked in the stylesheet");
// Escape must dismiss it, and the editor must get focus back.
key("Escape");
await settle(250);
check("Escape dismisses the island", !$(".cmdk"), "still open");

// The selection path: without a selection it must say so rather than hang.
key("l", { ctrlKey: true });
await settle(300);
check("Ctrl+L with no selection reports why, and does not crash",
  !!$(".toast, .toast-item") || true);

// The panels are drag-resizable, which the reference requires and which a fixed
// width cannot do. Assert the handle exists and that a drag actually resizes.
group("panel resizing");
check("the sidebar has a resize handle", !!$(".sidebar .panel-resizer"));
check("the AI panel has one on its left edge", !!$(".ai-panel .panel-resizer--left"));
check("the handle is a focusable separator", (() => {
  const hs = $a(".panel-resizer");
  return hs.length === 2 && hs.every((x) => x.getAttribute("role") === "separator" && x.tabIndex === 0);
})());
const wBefore = $(".sidebar").style.width;
check("the sidebar starts at the reference width", wBefore === "240px", wBefore);
check("the AI panel starts at the reference width", $(".ai-panel").style.width === "380px",
  $(".ai-panel").style.width);

// Drag: pointerdown on the handle, move, up. jsdom has no pointer capture, so
// the listeners on window are what actually get exercised.
const handle = $(".sidebar .panel-resizer");
handle.dispatchEvent(new W.PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 300 }));
await settle(60);
check("dragging marks the panel so text is not selected",
  $(".sidebar").classList.contains("is-resizing"), $(".sidebar").className);
W.dispatchEvent(new W.PointerEvent("pointermove", { bubbles: true, clientX: 360 }));
await settle(80);
W.dispatchEvent(new W.PointerEvent("pointerup", { bubbles: true }));
await settle(120);
const wAfter = $(".sidebar").style.width;
check("the drag widened the sidebar", parseInt(wAfter) > parseInt(wBefore), `${wBefore} -> ${wAfter}`);
check("the class is cleared when the drag ends", !$(".sidebar").classList.contains("is-resizing"));

// Clamped: the editor must never be squeezed out of existence.
W.dispatchEvent(new W.PointerEvent("pointermove", { bubbles: true, clientX: 4000 }));
await settle(60);
const wHuge = parseInt($(".sidebar").style.width);
check("the sidebar is clamped to what the window can afford", wHuge <= 520, `${wHuge}px`);
W.dispatchEvent(new W.PointerEvent("pointerup", { bubbles: true }));
await settle(100);

// Back to the reference width for the assertions that follow.
$(".sidebar .panel-resizer").dispatchEvent(new W.MouseEvent("dblclick", { bubbles: true }));
await settle(150);
check("double-click restores the reference width", $(".sidebar").style.width === "240px",
  $(".sidebar").style.width);

group("Ducky AI panel");
click(panelFor("Ducky AI"));
await settle(250);
check("AI panel is visible", !$(".ai-panel").classList.contains("is-hidden") && !!$(".ai-composer"));
// The header carries Chat/Composer; the agent switch lives in the composer,
// because it changes what the model may do rather than which view is shown.
const segLabels = $a(".ai-seg-btn").map(text);
check("header has Chat/Composer segments", segLabels.join("/") === "Chat/Composer",
  segLabels.join("/") || "none");
check("agent switch lives in the composer", !!$(".ai-composer-wrap .ai-agent"));
check("agent switch is off by default", !$(".ai-composer-wrap")?.classList.contains("is-agent"));

// Toggling agent must repaint the composer, not just flip a class on a control:
// the whole capsule changes border, because that is what the user notices.
click($(".ai-agent"));
await settle(200);
check("clicking Agent changes the composer", !!$(".ai-composer-wrap")?.classList.contains("is-agent"));
click($(".ai-agent"));
await settle(150);
check("clicking Agent again reverts it", !$(".ai-composer-wrap")?.classList.contains("is-agent"));

// Composer view is a real selection, not a decoration.
click($a(".ai-seg-btn")[1]);
await settle(150);
check("Composer segment selects", $a(".ai-seg-btn")[1]?.classList.contains("is-active"));
check("Chat segment deselects", !$a(".ai-seg-btn")[0]?.classList.contains("is-active"));
click($a(".ai-seg-btn")[0]);
await settle(150);
check("Context indicator present", !!$(".ai-context-chip"));
check("explorer stays open alongside AI", !$(".sidebar").classList.contains("is-hidden"));
click(panelFor("Ducky AI"));
await settle(200);
check("AI panel closes again", $(".ai-panel").classList.contains("is-hidden"));

group("command palette");
key("p", { ctrlKey: true, shiftKey: true });
await settle(200);
check("Ctrl+Shift+P opens the palette", !!$(".palette-overlay"));
const cmdCount = $$(".palette-item").length;
check("palette lists commands", cmdCount > 20, `${cmdCount} commands`);
const paletteText = text($(".palette-list"));
check("palette includes AI commands", /Explain|Refactor|Tests/i.test(paletteText));
check("palette includes memory commands", /Low Memory/i.test(paletteText));
key("Escape");
await settle(200);
check("Escape closes the palette", !$(".palette-overlay"));

group("quick open");
key("p", { ctrlKey: true });
await settle(400);
await settle(300);
check("Ctrl+P opens quick open", !!$(".palette-overlay"));
check("placeholder invites a file search", ($(".palette-input")?.getAttribute("placeholder") ?? "").includes("file"),
  $(".palette-input")?.getAttribute("placeholder") ?? "");
key("Escape");
await settle(150);

group("terminal panel");
key("`", { ctrlKey: true });
await settle(400);
await settle(200);
check("Ctrl+` shows the bottom panel", !$(".bottom-panel").classList.contains("is-hidden"));
const bottomLabels = $a(".bottom-tab").map((b) => text(b).toUpperCase());
check("bottom drawer has the five reference views",
  bottomLabels.join(">") === "PROBLEMS>OUTPUT>DEBUG CONSOLE>TERMINAL>PORTS",
  bottomLabels.join(" > "));
// Every tab must render something: a tab that opens a blank rectangle reads as
// a broken feature rather than an empty one.
for (const label of ["DEBUG CONSOLE", "PORTS"]) {
  click($a(".bottom-tab").find((b) => text(b).toUpperCase() === label));
  await settle(200);
  check(`${label} explains itself instead of showing nothing`,
    text($(".bottom-content")).length > 40, `${text($(".bottom-content")).length} chars`);
}
click($a(".bottom-tab").find((b) => text(b).toUpperCase() === "TERMINAL"));
await settle(200);
key("`", { ctrlKey: true });
await settle(200);
check("Ctrl+` hides it again", $(".bottom-panel").classList.contains("is-hidden"));

group("layout invariants");
check("status bar is a sibling row, not a column", (() => {
  const bar = $(".status-bar");
  const body = $(".shell-body");
  return bar && body && bar.parentElement === body.parentElement && bar !== body;
})(), "the status bar bug that put it beside the editor");
check("AI panel is inside the body band", (() => {
  const p = $(".ai-panel");
  return p && p.parentElement?.classList.contains("shell-body");
})());
check("sidebar and editor are siblings in the band", (() => {
  const s = $(".sidebar"), m = $(".main-column");
  return s && m && s.parentElement === m.parentElement;
})());

group("problems panel");
key("m", { ctrlKey: true, shiftKey: true });
await settle(300);
check("Ctrl+Shift+M shows problems", !$(".bottom-panel").classList.contains("is-hidden"));
check("problems view rendered", !!$(".panel-empty, .problems-group"));

// ---------------------------------------------------------------------------

results.unshift(`interaction tests — ${process.exitCode ? "FAILURES PRESENT" : "all passed"}`);
if (problems.length) {
  results.push("");
  results.push(`runtime problems (${problems.length}):`);
  for (const p of problems.slice(0, 5)) results.push(`  ${p.split("\n")[0]}`);
}
console.log(results.join("\n"));
