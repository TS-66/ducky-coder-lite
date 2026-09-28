/**
 * The command palette and Quick Open.
 *
 * Both are the same widget with a different data source, which is why they live
 * in one file: the keyboard handling, the fuzzy filter, the selection movement
 * and the rendering are shared and only the item list differs.
 *
 * ## Fuzzy matching
 *
 * A small subsequence scorer, not a library. It rewards consecutive runs, word
 * boundaries and matches in the filename over matches in the directory path, so
 * typing `mas` finds `src/components/Masthead.tsx`. Results are capped and the
 * *whole* list is filtered before rendering, so opening the palette on a
 * 48,000-file repository does not build 48,000 DOM rows.
 */

import { h, fill, clear, keyCombo, IS_MAC } from "../core/dom";
import { icons, langMonogram } from "./icons";
import { api, type NameHit } from "../core/backend";
import { store, openFile } from "../core/store";

export interface Command {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  icon?: () => SVGElement;
  run: () => void | Promise<void>;
  /** Hidden from the palette but still reachable by id. */
  hidden?: boolean;
}

interface PaletteItem {
  id: string;
  label: string;
  detail: string;
  hint?: string;
  icon?: () => SVGElement;
  score: number;
  run: () => void | Promise<void>;
}

let overlay: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let items: PaletteItem[] = [];
let filtered: PaletteItem[] = [];
let selected = 0;

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

/**
 * Score `haystack` against `needle`. Returns -1 for no match.
 *
 * A subsequence match is required; the bonus structure is what makes the *right*
 * match rank first. `mas` should find `Masthead` over `MySQLAdapterService`.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  const hay = haystack.toLowerCase();
  const pin = needle.toLowerCase();

  // Fast path: exact substring, weighted by where it sits.
  const direct = hay.indexOf(pin);
  if (direct !== -1) {
    const boundary = direct === 0 || /[^a-z0-9]/.test(hay[direct - 1] ?? "") ? 40 : 0;
    const fileStart = hay.lastIndexOf("/", direct) + 1;
    const inName = direct >= fileStart ? 30 : 0;
    return 1000 + boundary + inName - direct;
  }

  // Subsequence.
  let score = 0;
  let hi = 0;
  let lastMatched = -2;
  for (let ni = 0; ni < pin.length; ni++) {
    const c = pin[ni]!;
    let found = -1;
    while (hi < hay.length) {
      if (hay[hi] === c) {
        found = hi;
        break;
      }
      hi++;
    }
    if (found === -1) return -1;
    if (found === lastMatched + 1) score += 12; // consecutive
    if (found === 0 || /[^a-z0-9]/.test(hay[found - 1] ?? "")) score += 18; // word start
    score -= Math.min(8, found - lastMatched - 1);
    lastMatched = found;
    hi = found + 1;
  }
  // Prefer shorter paths.
  return 100 + score - Math.floor(haystack.length / 8);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildOverlay(placeholder: string, onDone: () => void): void {
  // Only tear down the previous DOM here. Calling the full `closePalette()`
  // would also clear `items`, and the callers populate `items` *before* calling
  // this function -- which left the palette permanently empty.
  teardownOverlay();

  listEl = h("div", { class: "palette-list" });
  inputEl = h("input", {
    class: "palette-input",
    type: "text",
    placeholder,
    spellcheck: false,
    autocomplete: "off",
    onInput: () => refresh(),
    onKeydown: (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
        case "PageDown":
          e.preventDefault();
          move(8);
          break;
        case "PageUp":
          e.preventDefault();
          move(-8);
          break;
        case "Enter":
          e.preventDefault();
          accept();
          break;
        case "Escape":
          e.preventDefault();
          closePalette();
          onDone();
          break;
        case "Tab":
          // Tab completes to the top item rather than moving focus, which is
          // what makes typing a path and pressing Tab twice fast.
          e.preventDefault();
          if (filtered.length) {
            inputEl!.value = filtered[0]!.label;
            refresh();
          }
          break;
      }
    },
  }) as HTMLInputElement;

  overlay = h(
    "div",
    {
      class: "palette-overlay",
      onMousedown: (e: MouseEvent) => {
        if (e.target === overlay) {
          closePalette();
          onDone();
        }
      },
    },
    h(
      "div",
      { class: "palette" },
      h("div", { class: "palette-head" }, icons.search(14), inputEl),
      listEl,
      h(
        "div",
        { class: "palette-foot" },
        h("span", null, h("kbd", null, "↑↓"), " navigate"),
        h("span", null, h("kbd", null, "↵"), " select"),
        h("span", null, h("kbd", null, "esc"), " dismiss"),
        h("span", { class: "palette-foot-spacer" }),
        h("span", { class: "palette-foot-brand" }, icons.duck(12), "Ducky Coder Lite"),
      ),
    ),
  );

  document.body.appendChild(overlay);
  inputEl.focus();
}

function refresh(): void {
  if (!listEl || !inputEl) return;
  const query = inputEl.value;
  const scored: PaletteItem[] = [];
  for (const item of items) {
    if (!query) {
      scored.push(item);
      continue;
    }
    const score = Math.max(
      fuzzyScore(item.label, query),
      item.detail ? fuzzyScore(item.detail, query) * 0.6 : -1,
    );
    if (score >= 0) scored.push({ ...item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  filtered = scored.slice(0, 60);
  selected = 0;
  paint();
}

function paint(): void {
  if (!listEl) return;
  if (filtered.length === 0) {
    fill(listEl, h("div", { class: "palette-empty" }, "No matching results"));
    return;
  }
  fill(
    listEl,
    ...filtered.map((item, i) => {
      const mono = langMonogram(extensionLanguage(item.label));
      return h(
        "div",
        {
          class: `palette-item${i === selected ? " is-selected" : ""}`,
          onClick: () => {
            selected = i;
            accept();
          },
          onMousemove: () => {
            if (selected !== i) {
              selected = i;
              paint();
            }
          },
        },
        h(
          "span",
          { class: "palette-item-icon" },
          item.icon ? item.icon() : mono.text ? h("span", { class: "file-badge", style: `color:${mono.color}` }, mono.text) : icons.file(13),
        ),
        h(
          "span",
          { class: "palette-item-main" },
          h("span", { class: "palette-item-label" }, item.label),
          item.detail ? h("span", { class: "palette-item-detail" }, item.detail) : null,
        ),
        item.hint ? h("kbd", { class: "palette-item-hint" }, item.hint) : null,
      );
    }),
  );
  const active = listEl.children[selected] as HTMLElement | undefined;
  active?.scrollIntoView({ block: "nearest" });
}

function move(delta: number): void {
  if (filtered.length === 0) return;
  selected = (selected + delta + filtered.length) % filtered.length;
  paint();
}

async function accept(): Promise<void> {
  const item = filtered[selected];
  if (!item) return;
  closePalette();
  try {
    await item.run();
  } catch (err) {
    console.error("[ducky] command failed", err);
  }
}

/** Remove the overlay DOM but keep the item list, for a rebuild in place. */
function teardownOverlay(): void {
  overlay?.remove();
  overlay = null;
  listEl = null;
  inputEl = null;
}

/** Dismiss the palette for good, releasing its items. */
function closePalette(): void {
  teardownOverlay();
  items = [];
  filtered = [];
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** The command palette. */
export function openCommandPalette(commands: Command[]): void {
  const visible = commands.filter((c) => !c.hidden);
  const nextItems = visible.map((c) => ({
    id: c.id,
    label: c.title,
    detail: c.category,
    hint: c.shortcut ? keyCombo(c.shortcut) : undefined,
    icon: c.icon,
    // Without a query, keep the declared order: that is the developer's
    // intended priority, and a score would scramble it.
    score: 0,
    run: c.run,
  }));

  buildOverlay("Type a command…", () => {});
  items = nextItems;
  refresh();
}

/** Quick Open: fuzzy search over workspace file names. */
export async function openQuickOpen(initial = ""): Promise<void> {
  const root = store.state.workspace?.root;
  if (!root) {
    openCommandPalette([]);
    return;
  }

  // The first paint is the recently-opened and currently-open files, so the
  // palette is useful before the user has typed anything.
  const openPaths = store.state.tabs.map((t) => t.path);
  const seed: PaletteItem[] = openPaths.map((p) => ({
    id: `open:${p}`,
    label: p,
    detail: "open",
    score: 0,
    run: async () => {
      await openFile(p, { preview: true });
    },
  }));

  buildOverlay("Search files by name…", () => {});
  items = [...seed];
  if (initial) inputEl!.value = initial;
  refresh();

  let latestQuery = initial;
  let generation = 0;

  const onInput = (): void => {
    const query = inputEl?.value ?? "";
    latestQuery = query;
    const mine = ++generation;
    if (!query) {
      items = [...seed];
      refresh();
      return;
    }
    // A short debounce so a fast typist does not launch a walk per character.
    window.setTimeout(() => {
      if (mine !== generation) return;
      void api
        .quickOpen(latestQuery, 80)
        .then((hits: NameHit[]) => {
          if (mine !== generation) return;
          items = [
            ...hits.map((hit) => ({
              id: `q:${hit.path}`,
              label: hit.path,
              detail: hit.isDir ? "folder" : "file",
              score: hit.score,
              run: async () => {
                if (hit.isDir) return;
                await openFile(hit.path, { preview: true });
              },
            })),
            ...seed,
          ];
          refresh();
        })
        .catch(() => {
          /* a failed search is not worth interrupting the user */
        });
    }, 110);
  };

  inputEl?.addEventListener("input", onInput);
}

function extensionLanguage(label: string): string {
  const name = label.split("/").pop() ?? label;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const map: Record<string, string> = {
    rs: "rust", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", lua: "lua", rb: "ruby", go: "go", java: "java", kt: "kotlin",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp", swift: "swift",
    php: "php", sh: "shell", bash: "shell", sql: "sql", html: "html", css: "css",
    json: "json", md: "markdown", yml: "yaml", toml: "toml", xml: "xml", vue: "vue",
  };
  return map[ext] ?? "";
}

export { clear, IS_MAC };
