/**
 * The status bar.
 *
 * The numbers here are real, read from `/proc/meminfo` and the process's own RSS
 * (plus the WebKit helper processes' RSS, which is the part that actually
 * dominates on Linux). Nothing is estimated or smoothed into fiction, and the
 * whole indicator can be switched off.
 *
 * Everything is a button: clicking any item opens the relevant panel, which is
 * the interaction model users already expect from a status bar.
 */

import { h, clear, formatBytes, IS_MAC } from "../core/dom";
import { icons } from "./icons";
import { store, type State } from "../core/store";

let lastSignature = "";

export function renderStatusBar(left: HTMLElement, right: HTMLElement, s: State): void {
  const active = store.state.tabs.find((t) => t.id === s.activeTabId);
  const mem = s.mem;

  const sig = [
    s.workspace?.root ?? "",
    s.pressure,
    s.settings?.lowMemory.enabled,
    s.lowMemoryNotice,
    mem ? `${mem.appTotalMb.toFixed(0)}/${mem.systemAvailableMb.toFixed(0)}` : "",
    s.aiConnected,
    s.chatStreaming,
    s.problems.filter((p) => p.severity === "error").length,
    s.problems.filter((p) => p.severity === "warning").length,
    s.search.query,
    active?.language ?? "",
    active?.dirty ?? false,
  ].join("~");

  if (sig === lastSignature) return;
  lastSignature = sig;

  // ---- Left ---------------------------------------------------------------
  const leftItems: HTMLElement[] = [];

  // The account tier leads the bar, as in the reference. It is the one status
  // item that is about the person rather than the project, and the brand purple
  // is what keeps it from being mistaken for a branch or a problem count.
  leftItems.push(
    h(
      "span",
      {
        class: "status-account",
        title: "Ducky account",
        onClick: () => {
          window.dispatchEvent(new CustomEvent("ducky:open-settings", { detail: "general" }));
        },
      },
      "LITE",
    ),
  );

  if (s.workspace) {
    leftItems.push(
      statusButton(
        icons.gitBranch(12),
        "Source Control",
        () => {
          store.update((st) => {
            st.activePanel = "scm";
            st.sidebarVisible = true;
            st.aiPanelVisible = false;
          });
        },
      ),
    );
  }

  const errorCount = s.problems.filter((p) => p.severity === "error").length;
  const warnCount = s.problems.filter((p) => p.severity === "warning").length;
  if (errorCount > 0 || warnCount > 0) {
    leftItems.push(
      statusButton(
        icons.error(12),
        `${errorCount} error${errorCount === 1 ? "" : "s"}, ${warnCount} warning${warnCount === 1 ? "" : "s"}`,
        () => {
          store.update((st) => {
            st.bottomPanel = "problems";
          });
        },
        "is-error",
      ),
    );
  }

  if (s.search.query) {
    leftItems.push(
      statusText(
        s.search.running
          ? "Searching…"
          : `${s.search.matches.length}${s.search.truncated ? "+" : ""} results`,
      ),
    );
  }

  const lowMemory = s.settings?.lowMemory.enabled ?? true;
  if (s.pressure === "critical") {
    leftItems.push(
      h(
        "button",
        {
          class: "status-item status-item--mem status-item--critical",
          title: s.lowMemoryNotice ?? "System memory is critically low. Ducky Coder Lite has reduced background activity.",
          onClick: () => openSettings("lowMemory"),
        },
        icons.memory(12),
        h("span", null, "LOW MEMORY"),
      ),
    );
  } else if (lowMemory) {
    leftItems.push(
      h(
        "button",
        {
          class: "status-item status-item--mem",
          title: "Low Memory Mode is on. Minimap, animations, extra caches and background indexing are disabled.",
          onClick: () => openSettings("lowMemory"),
        },
        icons.memory(12),
        h("span", null, "LOW MEMORY"),
      ),
    );
  }

  // ---- Right --------------------------------------------------------------
  const rightItems: HTMLElement[] = [];

  if (active) {
    if (active.eol) {
      rightItems.push(statusText(active.eol === "crlf" ? "CRLF" : "LF"));
    }
    rightItems.push(
      statusButton(
        h("span", { class: "status-xy" }, `${cursorPos.line}:${cursorPos.column}`),
        "Go to Line",
        () => window.dispatchEvent(new CustomEvent("ducky:goto-line")),
        "",
        [false, true],
      ),
    );
    const size = s.settings?.editor.tabSize ?? 4;
    rightItems.push(
      statusButton(
        h("span", { class: "status-xy" }, `Spaces: ${size}`),
        "Indentation",
        () => window.dispatchEvent(new CustomEvent("ducky:open-settings", { detail: "editor" })),
      ),
    );
    if (active.language && active.language !== "plaintext") {
      rightItems.push(statusText(toLanguageLabel(active.language)));
    }
    if (active.dirty) {
      rightItems.push(statusText("Unsaved"));
    }
  }

  // The performance indicator, exactly as specified, with real measurements.
  if (s.settings?.showPerformanceIndicator && mem) {
    // "Not set up" is only accurate when there is genuinely no provider. A
    // saved key means the editor is ready to talk to it, even before the first
    // request has proved the connection.
    const aiLabel = !s.settings?.ai.provider.hasKey
      ? "AI Not Set"
      : s.aiConnected === true
        ? "AI Connected"
        : s.aiConnected === false
          ? "AI Offline"
          : "AI Ready";
    const dotClass = !s.settings?.ai.provider.hasKey
      ? "is-unknown"
      : s.aiConnected === true
        ? "is-ok"
        : s.aiConnected === false
          ? "is-off"
          : "is-ok";

    rightItems.push(
      h(
        "button",
        {
          class: "status-item status-item--perf",
          title: perfTooltip(mem, s),
          onClick: () => openSettings("performance"),
        },
        h("span", { class: "status-perf-ram" }, `RAM ${formatBytes(Math.round(mem.appTotalMb * 1024 * 1024))}`),
        h("span", { class: "status-perf-sep" }, "·"),
        h("span", null, `Free ${formatBytes(Math.round(mem.systemAvailableMb * 1024 * 1024))}`),
        h("span", { class: "status-perf-sep" }, "·"),
        h("span", { class: `status-perf-dot ${dotClass}` }),
        h("span", null, aiLabel),
      ),
    );
  }

  clear(left);
  left.append(...leftItems);
  clear(right);
  right.append(...rightItems);
}

function perfTooltip(
  mem: NonNullable<State["mem"]>,
  s: State,
): string {
  const lines = [
    `Ducky Coder Lite memory report`,
    ``,
    `Editor process: ${mem.processRssMb.toFixed(1)} MB`,
    `Web view:       ${mem.webviewRssMb.toFixed(1)} MB`,
    `Total:          ${mem.appTotalMb.toFixed(1)} MB`,
    ``,
    `System total:   ${mem.systemTotalMb.toFixed(0)} MB`,
    `System used:    ${mem.systemUsedMb.toFixed(0)} MB`,
    `Available:      ${mem.systemAvailableMb.toFixed(0)} MB (${(mem.availableRatio * 100).toFixed(0)}%)`,
    `Swap in use:    ${mem.swapUsedMb.toFixed(0)} MB`,
    `Threads:        ${mem.threadCount}`,
  ];
  if (s.settings?.lowMemory.enabled) {
    lines.push(``, `Low Memory Mode is ON.`);
  }
  lines.push(``, `Click to open Settings › Performance.`);
  return lines.join("\n");
}

/** Cursor position lives outside the store: it changes on every arrow key and
 *  pushing it through the store would re-render the whole app 30 times a second. */
export const cursorPos = { line: 1, column: 1 };

export function setCursorPos(line: number, column: number): void {
  if (cursorPos.line === line && cursorPos.column === column) return;
  cursorPos.line = line;
  cursorPos.column = column;
  lastSignature = "";
  store.notify();
}

function statusText(text: string): HTMLElement {
  return h("span", { class: "status-item status-item--static" }, text);
}

function statusButton(
  content: Node | string,
  title: string,
  onClick: () => void,
  className = "",
  dims: [boolean, boolean] = [false, false],
): HTMLElement {
  return h(
    "button",
    {
      class: `status-item ${className}`.trim(),
      title,
      onClick,
      ...(dims[0] ? { style: "min-width:52px" } : {}),
    },
    content,
  );
}

function openSettings(section: string): void {
  window.dispatchEvent(new CustomEvent("ducky:open-settings", { detail: section }));
}

const LANGUAGE_LABELS: Record<string, string> = {
  rust: "Rust", typescript: "TypeScript", tsx: "TypeScript JSX", javascript: "JavaScript",
  jsx: "JavaScript JSX", json: "JSON", json5: "JSON5", python: "Python", lua: "Lua",
  ruby: "Ruby", go: "Go", java: "Java", kotlin: "Kotlin", c: "C", cpp: "C++",
  csharp: "C#", swift: "Swift", php: "PHP", shell: "Shell Script", fish: "Fish",
  powershell: "PowerShell", batch: "Batch", sql: "SQL", html: "HTML", css: "CSS",
  sass: "Sass", less: "Less", vue: "Vue", svelte: "Svelte", markdown: "Markdown",
  yaml: "YAML", toml: "TOML", ini: "Config", xml: "XML", dockerfile: "Dockerfile",
  graphql: "GraphQL", protobuf: "Protocol Buffers", terraform: "Terraform", zig: "Zig",
  elixir: "Elixir", erlang: "Erlang", haskell: "Haskell", clojure: "Clojure",
  scala: "Scala", dart: "Dart", r: "R", julia: "Julia", diff: "Diff", text: "Plain Text",
  plaintext: "Plain Text", dotenv: "Environment", gitignore: "Git Ignore",
  lockfile: "Lock File", perl: "Perl", vb: "Visual Basic", scheme: "Scheme",
  makefile: "Makefile", cmake: "CMake",
};

export function toLanguageLabel(lang: string): string {
  return LANGUAGE_LABELS[lang] ?? lang;
}

export function resetStatusSignature(): void {
  lastSignature = "";
}

export { IS_MAC, icons };
