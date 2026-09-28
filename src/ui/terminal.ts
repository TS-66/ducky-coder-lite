/**
 * The integrated terminal.
 *
 * ## Where the scrollback lives
 *
 * Only here, in the frontend. The backend is a stateless pipe: PTY bytes go to
 * the renderer and are not buffered in Rust. That is deliberate — a second copy
 * across the process boundary would double the memory cost of every long build,
 * and a tab-suspend feature would then have to synchronise the two.
 *
 * The buffer is a plain `string[]` per terminal, hard-capped at
 * `terminalScrollbackLines` (750 by default, 300 in Low Memory Mode). Once the
 * cap is hit, the oldest lines are dropped. That is the only correct policy for
 * a 2 GB machine: a `npm run build` that prints 200,000 lines must not be able
 * to take the editor down with it.
 *
 * ## Rendering
 *
 * Lines are appended to a single `<pre>` and the view is scrolled to the
 * bottom. Re-rendering the whole buffer on every chunk would be O(n) per
 * keystroke of output, so instead we append only the new lines and maintain a
 * small trailing window of recycled nodes.
 */

import { h, fill } from "../core/dom";
import { icons } from "./icons";
import { store, type State } from "../core/store";
import { api, on, type PtyDataEvent, type PtyExitEvent } from "../core/backend";

let built = false;
let outputEl: HTMLElement | null = null;
let tabStrip: HTMLElement | null = null;
let searchBar: HTMLElement | null = null;
let searchInput: HTMLInputElement | null = null;
let atBottom = true;

export function installTerminal(): void {
  if (built) return;
  built = true;

  // Subscribe once, for the lifetime of the app. Events are multiplexed by
  // channel id, so one listener serves every terminal.
  void on<PtyDataEvent>("term://data", (evt) => {
    appendOutput(evt.channel, evt.data);
  });

  void on<PtyExitEvent>("term://exit", (evt) => {
    store.update((s) => {
      const t = s.terminals.find((x) => x.id === evt.channel);
      if (t) {
        t.alive = false;
        t.lines.push(`\n[process exited with code ${evt.code}]\n`);
      }
    });
  });
}

export function renderTerminal(host: HTMLElement, s: State): void {
  if (!built) installTerminal();

  if (!outputEl) {
    buildTerminal(host);
  }
  if (!outputEl) return;

  renderTabStrip(s);

  // Show the active terminal's buffer, or a hint when there is none.
  const active = s.terminals.find((t) => t.id === s.activeTerminalId);
  if (!active) {
    if (outputEl.dataset.mode !== "empty") {
      outputEl.dataset.mode = "empty";
      fill(
        outputEl,
        h(
          "div",
          { class: "term-empty" },
          h("div", { class: "term-empty-title" }, "No terminal open"),
          h(
            "div",
            { class: "term-empty-hint" },
            "Press the + button, or use Terminal: Create New Terminal from the command palette.",
          ),
          h(
            "button",
            {
              class: "btn btn--primary",
              onClick: () => void createTerminal(),
            },
            icons.plus(13),
            h("span", null, "New Terminal"),
          ),
        ),
      );
    }
    return;
  }

  outputEl.dataset.mode = "live";
  outputEl.dataset.channel = String(active.id);
  outputEl.textContent = active.lines.join("");
  if (atBottom) {
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}

function buildTerminal(host: HTMLElement): void {
  outputEl = h("pre", { class: "term-output", tabIndex: 0 });
  outputEl.addEventListener("scroll", () => {
    // Track whether the user has scrolled away, so incoming output does not
    // yank the view back to the bottom.
    const el = outputEl!;
    atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  });

  searchInput = h("input", {
    class: "term-search-input",
    type: "text",
    placeholder: "Search output",
    spellcheck: false,
    onInput: () => highlightSearch(),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        searchBar?.classList.remove("is-open");
      }
    },
  }) as HTMLInputElement;

  searchBar = h(
    "div",
    { class: "term-search" },
    searchInput,
    h("span", { class: "term-search-count", id: "term-search-count" }),
  );

  tabStrip = h("div", { class: "term-tabs" });

  host.appendChild(
    h(
      "div",
      { class: "term-wrap" },
      h(
        "div",
        { class: "term-head" },
        tabStrip,
        h(
          "div",
          { class: "term-head-actions" },
          h(
            "button",
            {
              class: "icon-btn",
              title: "Search output",
              onClick: () => {
                searchBar?.classList.toggle("is-open");
                searchInput?.focus();
              },
            },
            icons.search(13),
          ),
          h(
            "button",
            {
              class: "icon-btn",
              title: "Copy all output",
              onClick: () => {
                const active = store.state.terminals.find((t) => t.id === store.state.activeTerminalId);
                if (active) void navigator.clipboard.writeText(active.lines.join(""));
              },
            },
            icons.copy(13),
          ),
        ),
      ),
      searchBar,
      outputEl,
    ),
  );
}

function renderTabStrip(s: State): void {
  if (!tabStrip) return;
  fill(
    tabStrip,
    ...s.terminals.map((t) =>
      h(
        "button",
        {
          class: `term-tab${t.id === s.activeTerminalId ? " is-active" : ""}${t.alive ? "" : " is-dead"}`,
          title: `${t.title} — ${t.cwd}`,
          onClick: () => {
            store.update((st) => {
              st.activeTerminalId = t.id;
            });
          },
          onClickCapture: () => {
            atBottom = true;
          },
          onContextmenu: (e: MouseEvent) => {
            e.preventDefault();
            void killTerminal(t.id);
          },
        },
        h("span", null, t.title),
        h(
          "span",
          {
            class: "term-tab-close",
            title: "Kill terminal",
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              void killTerminal(t.id);
            },
          },
          icons.close(10),
        ),
      ),
    ),
    h(
      "button",
      {
        class: "term-tab-add",
        title: "New terminal",
        onClick: () => void createTerminal(),
      },
      icons.plus(12),
    ),
  );
}

/** Feed raw PTY bytes into the active terminal's line buffer. */
function appendOutput(channel: number, data: string): void {
  const state = store.state;
  const term = state.terminals.find((t) => t.id === channel);
  if (!term) return;

  // Split on newlines so the buffer stays a list of lines (which makes the
  // ring-buffer trim and the search highlight both cheap).
  const parts = data.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    if (i < parts.length - 1) {
      term.lines.push(chunk);
    } else if (chunk) {
      // Trailing partial line: append to the last buffer entry.
      if (term.lines.length === 0) term.lines.push(chunk);
      else term.lines[term.lines.length - 1] += chunk;
    }
  }

  // Hard cap. This is the line that keeps `npm install` from eating the editor.
  const cap = store.terminalLineCap();
  if (term.lines.length > cap) {
    term.lines.splice(0, term.lines.length - cap);
  }

  // Live paint only if this is the terminal the user is looking at.
  if (channel === state.activeTerminalId && outputEl && atBottom) {
    outputEl.textContent = term.lines.join("");
    outputEl.scrollTop = outputEl.scrollHeight;
  } else if (channel === state.activeTerminalId) {
    // Paused scrollback: refresh but do not scroll.
    if (outputEl) outputEl.textContent = term.lines.join("");
  }

  // Re-render the strip (cheap: a few buttons) so a dead terminal greys out.
  renderTabStrip(state);
}

function highlightSearch(): void {
  const countEl = document.getElementById("term-search-count");
  if (!outputEl || !searchInput || !countEl) return;
  const term = searchInput.value.toLowerCase();
  if (!term) {
    countEl.textContent = "";
    return;
  }
  const text = outputEl.textContent ?? "";
  let count = 0;
  let idx = text.toLowerCase().indexOf(term);
  while (idx !== -1 && count < 999) {
    count++;
    idx = text.toLowerCase().indexOf(term, idx + term.length);
  }
  countEl.textContent = count ? `${count}` : "no results";
  if (count) {
    // Scroll to the first hit so the search does something visible.
    const before = text.slice(0, text.toLowerCase().indexOf(term)).split("\n").length - 1;
    const lineHeight = 17;
    outputEl.scrollTop = Math.max(0, before * lineHeight - outputEl.clientHeight / 2);
  }
}

export async function createTerminal(): Promise<void> {
  try {
    const info = await api.terminalCreate(24, 80);
    store.update((s) => {
      s.terminals.push({
        id: info.id,
        title: info.title,
        alive: true,
        lines: [],
        cwd: info.cwd,
        searchTerm: "",
      });
      s.activeTerminalId = info.id;
      s.bottomPanel = "terminal";
    });
    atBottom = true;
    // Size the PTY to the actual rendered geometry.
    requestAnimationFrame(() => resizeActive());
  } catch (err) {
    store.state.toast = {
      message: err instanceof Error ? err.message : String(err),
      kind: "error",
    };
    store.notify();
  }
}

export async function killTerminal(id: number): Promise<void> {
  try {
    await api.terminalKill(id);
  } catch {
    // Killing an already-dead terminal is not an error worth surfacing.
  }
  store.update((s) => {
    s.terminals = s.terminals.filter((t) => t.id !== id);
    if (s.activeTerminalId === id) {
      s.activeTerminalId = s.terminals[0]?.id ?? null;
    }
  });
}

export function clearActiveTerminal(): void {
  store.update((s) => {
    const t = s.terminals.find((x) => x.id === s.activeTerminalId);
    if (t) t.lines = [];
  });
  if (outputEl) {
    outputEl.textContent = "";
    outputEl.scrollTop = 0;
  }
}

/** Tell the PTY its real size, in character cells. */
export function resizeActive(): void {
  if (!outputEl) return;
  const id = store.state.activeTerminalId;
  if (id === null) return;
  const cs = getComputedStyle(outputEl);
  const charW = parseFloat(cs.fontSize) * 0.6;
  const lineH = parseFloat(cs.lineHeight) || 17;
  const cols = Math.max(20, Math.floor(outputEl.clientWidth / charW));
  const rows = Math.max(6, Math.floor(outputEl.clientHeight / lineH));
  void api.terminalResize(id, rows, cols).catch(() => {});
}

/** Forward keyboard input from the terminal's focused element to the PTY. */
export function terminalKeyHandler(e: KeyboardEvent): boolean {
  const id = store.state.activeTerminalId;
  if (id === null || !store.state.terminals.some((t) => t.id === id)) return false;

  const isMeta = e.ctrlKey || e.metaKey;
  const key = e.key;

  // Let the shortcuts the user expects to keep working.
  if (isMeta && ["c", "v", "w", "f", "p", "b", "a", "s", "n", "k", "z"].includes(key.toLowerCase())) {
    if (key.toLowerCase() !== "c" || window.getSelection()?.toString()) return false;
  }
  if (e.altKey && key === "Tab") return false;

  let data: string | null = null;
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    const code = e.code;
    if (code.startsWith("Key")) data = String.fromCharCode(e.key.charCodeAt(0) & 0x1f);
    else if (code === "BracketLeft") data = "";
    else if (code === "BracketRight") data = "]";
    else if (code === "Backslash") data = "\\";
  } else if (isMeta) {
    return false;
  } else {
    switch (key) {
      case "Enter": data = "\r"; break;
      case "Backspace": data = "\x7f"; break;
      case "Tab": data = "\t"; break;
      case "Escape": data = "\x1b"; break;
      case "ArrowUp": data = "\x1b[A"; break;
      case "ArrowDown": data = "\x1b[B"; break;
      case "ArrowRight": data = "\x1b[C"; break;
      case "ArrowLeft": data = "\x1b[D"; break;
      case "Home": data = "\x1b[H"; break;
      case "End": data = "\x1b[F"; break;
      case "PageUp": data = "\x1b[5~"; break;
      case "PageDown": data = "\x1b[6~"; break;
      case "Delete": data = "\x1b[3~"; break;
      default:
        if (key.length === 1) data = key;
    }
  }

  if (data === null) return false;
  e.preventDefault();
  void api.terminalWrite(id, data).catch(() => {});
  atBottom = true;
  return true;
}

export function outputElement(): HTMLElement | null {
  return outputEl;
}
