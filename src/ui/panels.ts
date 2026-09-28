/**
 * The search panel, source control panel, run panel, extensions panel and
 * problems panel.
 *
 * They are grouped in one module because they are all thin views over backend
 * commands with no shared behaviour beyond that, and because keeping them
 * together makes the shared conventions (section header, empty state, row
 * action buttons) obvious.
 *
 * The convention each of them follows: render is idempotent and cheap, mutation
 * goes through the store, and a long operation is debounced and cancellable.
 */

import { h, fill, clear, debounce, escapeHtml, formatBytes } from "../core/dom";
import { icons, langMonogram } from "./icons";
import { openMenu, type MenuItem } from "./explorer";
import { store, openFile, toast, type State } from "../core/store";
import { api, type RepoStatus, type CommitInfo, type StatusEntry } from "../core/backend";
import { openDiff } from "./diff";
import { runQuickAction, type QuickAction } from "./inline-ai";
import { confirmCommand } from "./ai-panel";

// ===========================================================================
// Search
// ===========================================================================

let searchMounted = false;
let searchInputEl: HTMLInputElement | null = null;
let searchResultsEl: HTMLElement | null = null;
let searchSummaryEl: HTMLElement | null = null;

const runSearch = debounce(async (query: string) => {
  if (!query.trim()) {
    store.update((s) => {
      s.search.matches = [];
      s.search.filesScanned = 0;
      s.search.truncated = false;
      s.search.running = false;
    });
    return;
  }
  const s = store.state.search;
  try {
    const res = await api.searchWorkspace(query, {
      useRegex: s.useRegex,
      caseSensitive: s.caseSensitive,
      wholeWord: s.wholeWord,
      includePattern: s.includePattern || null,
    });
    // Ignore a response the user has already typed past.
    if (store.state.search.query !== query) return;
    store.update((st) => {
      st.search.matches = res.matches;
      st.search.filesScanned = res.filesScanned;
      st.search.truncated = res.truncated;
      st.search.elapsedMs = res.elapsedMs;
      st.search.running = false;
      st.search.selectedIndex = 0;
    });
  } catch (err) {
    const cancelled = (err as { cancelled?: boolean }).cancelled;
    store.update((st) => {
      st.search.running = false;
      if (!cancelled) {
        st.search.matches = [];
        st.search.filesScanned = 0;
        st.search.query = query;
      }
    });
    if (!cancelled) toast(err instanceof Error ? err.message : String(err), "error");
  }
}, 220);

export function focusSearch(): void {
  if (!searchInputEl) {
    store.update((s) => {
      s.activePanel = "search";
      s.sidebarVisible = true;
      s.aiPanelVisible = false;
    });
    // The input exists after the next render.
    queueMicrotask(() => searchInputEl?.focus());
    return;
  }
  searchInputEl.focus();
  searchInputEl.select();
}

export function renderSearch(host: HTMLElement, s: State): void {
  if (!searchMounted) {
    searchMounted = true;
    buildSearch(host);
  }
  if (searchInputEl && document.activeElement !== searchInputEl) {
    searchInputEl.value = s.search.query;
  }
  if (searchSummaryEl) {
    const matches = s.search.matches;
    searchSummaryEl.textContent = s.search.running
      ? "Searching…"
      : matches.length === 0 && s.search.query
        ? "No results"
        : `${matches.length}${s.search.truncated ? "+" : ""} results in ${s.search.filesScanned} file${s.search.filesScanned === 1 ? "" : "s"} · ${s.search.elapsedMs} ms`;
  }
  renderSearchResults();
}

function buildSearch(host: HTMLElement): void {
  searchInputEl = h("input", {
    class: "search-input",
    type: "text",
    placeholder: "Search",
    spellcheck: false,
    onInput: (e: Event) => {
      const value = (e.target as HTMLInputElement).value;
      store.update((st) => {
        st.search.query = value;
        st.search.running = value.trim().length > 0;
      });
      if (value.trim()) runSearch(value);
      else {
        runSearch.cancel();
        void api.cancelSearch().catch(() => {});
        store.update((st) => {
          st.search.matches = [];
          st.search.running = false;
        });
      }
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runSearch.flush();
      } else if (e.key === "Escape") {
        e.preventDefault();
        searchInputEl?.blur();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        store.update((st) => {
          st.search.selectedIndex = Math.min(st.search.selectedIndex + 1, st.search.matches.length - 1);
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        store.update((st) => {
          st.search.selectedIndex = Math.max(st.search.selectedIndex - 1, 0);
        });
      }
    },
  }) as HTMLInputElement;

  searchSummaryEl = h("div", { class: "search-summary" });
  searchResultsEl = h("div", { class: "search-results" });

  const options = h(
    "details",
    { class: "search-options" },
    h("summary", null, "Search options"),
    toggleRow("Match Case", (v) => {
      store.update((st) => {
        st.search.caseSensitive = v;
      });
      if (store.state.search.query) runSearch(store.state.search.query);
    }),
    toggleRow("Match Whole Word", (v) => {
      store.update((st) => {
        st.search.wholeWord = v;
      });
      if (store.state.search.query) runSearch(store.state.search.query);
    }),
    toggleRow("Use Regular Expression", (v) => {
      store.update((st) => {
        st.search.useRegex = v;
      });
      if (store.state.search.query) runSearch(store.state.search.query);
    }),
    h(
      "label",
      { class: "search-include" },
      h("span", null, "Files to include"),
      h("input", {
        type: "text",
        placeholder: "e.g. *.ts  or  src/**",
        spellcheck: false,
        onChange: (e: Event) => {
          const v = (e.target as HTMLInputElement).value.trim();
          store.update((st) => {
            st.search.includePattern = v;
          });
          if (store.state.search.query) runSearch(store.state.search.query);
        },
      }),
    ),
  );

  host.appendChild(
    h(
      "div",
      { class: "search-wrap" },
      h(
        "div",
        { class: "search-input-row" },
        h(
          "button",
          {
            class: "icon-btn",
            title: "Clear search",
            onClick: () => {
              if (searchInputEl) searchInputEl.value = "";
              store.update((st) => {
                st.search.query = "";
                st.search.matches = [];
              });
              void api.cancelSearch().catch(() => {});
            },
          },
          icons.close(13),
        ),
        searchInputEl,
      ),
      h(
        "div",
        { class: "search-toggles" },
        quickToggle("Aa", "Match Case", (v) => {
          store.update((st) => {
            st.search.caseSensitive = v;
          });
          if (store.state.search.query) runSearch(store.state.search.query);
        }),
        quickToggle("ab|", "Whole Word", (v) => {
          store.update((st) => {
            st.search.wholeWord = v;
          });
          if (store.state.search.query) runSearch(store.state.search.query);
        }),
        quickToggle(".*", "Regular Expression", (v) => {
          store.update((st) => {
            st.search.useRegex = v;
          });
          if (store.state.search.query) runSearch(store.state.search.query);
        }),
      ),
      searchSummaryEl,
      options,
      searchResultsEl,
    ),
  );

  applyToggleStates();
}

function quickToggle(text: string, title: string, onChange: (v: boolean) => void): HTMLElement {
  return h(
    "button",
    {
      class: "search-toggle",
      title,
      onClick: (e: MouseEvent) => {
        const btn = e.currentTarget as HTMLElement;
        btn.classList.toggle("is-on");
        onChange(btn.classList.contains("is-on"));
      },
    },
    text,
  );
}

function toggleRow(label: string, onChange: (v: boolean) => void): HTMLElement {
  const input = h("input", {
    type: "checkbox",
    onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
  return h("label", { class: "toggle-row" }, input, h("span", null, label));
}

function applyToggleStates(): void {
  const s = store.state.search;
  const rows = document.querySelectorAll<HTMLInputElement>(".search-options .toggle-row input");
  if (rows[0]) rows[0].checked = s.caseSensitive;
  if (rows[1]) rows[1].checked = s.wholeWord;
  if (rows[2]) rows[2].checked = s.useRegex;
  const btns = document.querySelectorAll<HTMLElement>(".search-toggle");
  btns[0]?.classList.toggle("is-on", s.caseSensitive);
  btns[1]?.classList.toggle("is-on", s.wholeWord);
  btns[2]?.classList.toggle("is-on", s.useRegex);
}

function renderSearchResults(): void {
  if (!searchResultsEl) return;
  const s = store.state.search;
  const matches = s.matches;

  if (!s.query) {
    fill(
      searchResultsEl,
      h(
        "div",
        { class: "panel-empty" },
        h("div", { class: "panel-empty-title" }, "Search across your project"),
        h(
          "div",
          { class: "panel-empty-text" },
          "Results stream in as they are found and stop at a fixed limit, so a large repository stays fast. Build folders like node_modules and target are skipped by default.",
        ),
      ),
    );
    return;
  }

  if (matches.length === 0) {
    fill(
      searchResultsEl,
      h("div", { class: "panel-empty" }, s.running ? "Searching…" : "No results found."),
    );
    return;
  }

  // Group by file, which is how people read search results.
  const byFile = new Map<string, typeof matches>();
  for (const m of matches) {
    const list = byFile.get(m.path);
    if (list) list.push(m);
    else byFile.set(m.path, [m]);
  }

  // Only the first 40 files are expanded; the rest list their file names, which
  // keeps a 2,000-match search from creating 2,000 rows.
  const fileEntries = [...byFile.entries()];
  fill(
    searchResultsEl,
    ...fileEntries.slice(0, 40).map(([path, list], fileIndex) =>
      h(
        "div",
        { class: "search-file" },
        h(
          "button",
          {
            class: "search-file-head",
            onClick: () => {
              void openFile(path, { preview: true });
            },
            onContextmenu: (e: MouseEvent) => {
              e.preventDefault();
              showFileMenu(e.clientX, e.clientY, path);
            },
          },
          h("span", { class: "search-file-chevron" }, icons.chevronDown(11)),
          fileIconFor(path),
          h("span", { class: "search-file-name" }, path.split("/").pop()),
          h("span", { class: "search-file-dir" }, path.split("/").slice(0, -1).join("/")),
          h("span", { class: "search-file-count" }, String(list.length)),
        ),
        ...list.slice(0, 30).map((m, i) =>
          h(
            "button",
            {
              class: `search-hit${fileIndex === 0 && i === s.selectedIndex ? " is-selected" : ""}`,
              onClick: async () => {
                await openFile(path, { preview: true });
                queueMicrotask(() => {
                  window.dispatchEvent(
                    new CustomEvent("ducky:reveal", { detail: { path, line: m.line, column: m.column } }),
                  );
                });
              },
              onContextmenu: (e: MouseEvent) => {
                e.preventDefault();
                showFileMenu(e.clientX, e.clientY, path);
              },
            },
            h("span", { class: "search-hit-line" }, String(m.line)),
            h("span", { class: "search-hit-text" }, highlightMatch(m.preview, m.matchStart, m.matchLength)),
          ),
        ),
        list.length > 30
          ? h("div", { class: "search-more" }, `… ${list.length - 30} more matches in this file`)
          : null,
      ),
    ),
    fileEntries.length > 40
      ? h("div", { class: "search-more" }, `… and ${fileEntries.length - 40} more files`)
      : null,
    s.truncated
      ? h(
          "div",
          { class: "search-limit" },
          icons.info(12),
          h("span", null, "Result limit reached. Narrow the search to see more."),
        )
      : null,
  );
}

function highlightMatch(preview: string, start: number, length: number): HTMLElement {
  const el = h("span");
  // Offsets arrive in bytes; slice by code point to avoid splitting a character.
  const chars = [...preview];
  const a = Math.max(0, Math.min(chars.length, start));
  const b = Math.max(a, Math.min(chars.length, start + length));
  el.append(
    document.createTextNode(chars.slice(0, a).join("")),
    h("mark", { class: "search-mark" }, chars.slice(a, b).join("")),
    document.createTextNode(chars.slice(b).join("")),
  );
  return el;
}

function fileIconFor(path: string): HTMLElement {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const map: Record<string, string> = {
    rs: "rust", ts: "typescript", tsx: "tsx", js: "javascript", py: "python",
    lua: "lua", go: "go", rb: "ruby", json: "json", md: "markdown", toml: "toml",
    yml: "yaml", sh: "shell", css: "css", html: "html", sql: "sql", java: "java",
  };
  const mono = langMonogram(map[ext] ?? "");
  return mono.text
    ? h("span", { class: "file-badge", style: `color:${mono.color}` }, mono.text)
    : h("span", { class: "search-file-icon" }, icons.file(12));
}

function showFileMenu(x: number, y: number, path: string): void {
  openMenu(x, y, [
    {
      label: "Open",
      icon: icons.file,
      run: () => void openFile(path, { preview: true }),
    },
    {
      label: "Copy Path",
      icon: icons.copy,
      run: () => void navigator.clipboard.writeText(path),
    },
    {
      label: "Add to AI Context",
      icon: icons.sparkle,
      run: () => {
        store.update((s) => {
          if (!s.pinnedContext.includes(path)) s.pinnedContext.push(path);
        });
        toast("Added to the AI context.", "success");
      },
    },
    { separator: true, label: "" },
    {
      label: "Replace All in File…",
      icon: icons.edit,
      run: () => {
        const query = store.state.search.query;
        if (!query) return;
        const replacement = window.prompt(`Replace all "${query}" in ${path} with:`, "");
        if (replacement === null) return;
        void replaceInFile(path, query, replacement);
      },
    },
    {
      label: "Replace in Workspace…",
      icon: icons.search,
      run: () => void replaceInWorkspace(),
    },
  ]);
}

async function replaceInFile(path: string, query: string, replacement: string): Promise<void> {
  try {
    const file = await api.readFile(path);
    if (!file.content) {
      toast("Could not read that file.", "error");
      return;
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const useRegex = store.state.search.useRegex;
    const re = useRegex ? new RegExp(escaped, "g") : new RegExp(escaped, "gi");
    const next = file.content.replace(re, replacement);
    if (next === file.content) {
      toast("No replacements were made.", "info");
      return;
    }
    openDiff({
      path,
      before: file.content,
      after: next,
      title: `Replace "${query}" in ${path.split("/").pop()}`,
      onAccept: async (after) => {
        await api.writeFile(path, after);
        const tab = store.state.tabs.find((t) => t.path === path);
        if (tab) {
          store.update((s) => {
            const t = s.tabs.find((x) => x.path === path);
            if (t) {
              t.content = after;
              t.dirty = false;
            }
          });
        }
        toast(`Updated ${path}.`, "success");
      },
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function replaceInWorkspace(): Promise<void> {
  const query = store.state.search.query;
  if (!query) return;
  const replacement = window.prompt(`Replace "${query}" across ${store.state.search.matches.length} matches with:`, "");
  if (replacement === null) return;

  // Group by file so each file is written once.
  const files = new Set(store.state.search.matches.map((m) => m.path));
  let changed = 0;
  for (const path of files) {
    try {
      const file = await api.readFile(path);
      if (!file.content) continue;
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = store.state.search.useRegex ? new RegExp(escaped, "g") : new RegExp(escaped, "gi");
      const next = file.content.replace(re, replacement);
      if (next === file.content) continue;
      await api.writeFile(path, next);
      changed++;
      const tab = store.state.tabs.find((t) => t.path === path);
      if (tab) {
        store.update((s) => {
          const t = s.tabs.find((x) => x.path === path);
          if (t) {
            t.content = next;
            t.dirty = false;
          }
        });
      }
    } catch {
      // Skip files we cannot read or write rather than aborting the batch.
    }
  }
  toast(`Updated ${changed} file${changed === 1 ? "" : "s"}.`, "success");
  if (store.state.search.query) runSearch(store.state.search.query);
}

// ===========================================================================
// Source control
// ===========================================================================

let scmMounted = false;
let repo: RepoStatus | null = null;
let commits: CommitInfo[] = [];
let scmBusy = false;
let scmSignature = "";
/** Why the SCM panel has nothing to show, captured before narrowing. */
let repoReason = "";

export function refreshScm(): void {
  if (scmBusy) return;
  scmBusy = true;
  void api
    .gitStatus()
    .then((status) => {
      repo = status;
      repoReason = status.unavailableReason ?? "";
      scmSignature = "";
      if (status.isRepo) return api.gitLog(30);
      return [] as CommitInfo[];
    })
    .then((log) => {
      commits = log;
    })
    .catch((err: unknown) => {
      repo = null;
      repoReason = err instanceof Error ? err.message : String(err);
      scmSignature = "";
    })
    .finally(() => {
      scmBusy = false;
      store.update((s) => {
        s.problems = s.problems;
      });
    });
}

export function renderScm(host: HTMLElement): void {
  if (!scmMounted) {
    scmMounted = true;
    host.appendChild(h("div", { class: "scm-wrap", id: "scm-wrap" }));
    if (!repo) refreshScm();
  }
  const wrap = host.querySelector<HTMLElement>("#scm-wrap");
  if (!wrap) return;

  const sig = repo
    ? `${repo.branch}|${repo.entries.map((e) => `${e.path}${e.status}${e.staged ? "s" : ""}`).join(",")}|${repo.ahead}/${repo.behind}|${commits.length}`
    : `none|${repoReason}`;
  if (sig === scmSignature) return;
  scmSignature = sig;

  if (!repo) {
    const reason = repoReason;
    fill(
      wrap,
      h(
        "div",
        { class: "panel-empty" },
        h("div", { class: "panel-empty-title" }, "Source Control"),
        h(
          "div",
          { class: "panel-empty-text" },
          reason || "Loading…",
        ),
        h(
          "button",
          {
            class: "btn",
            onClick: () => void api.gitInit().then(refreshScm).catch((e) => toast(String(e), "error")),
          },
          h("span", null, "Initialize Repository"),
        ),
      ),
    );
    return;
  }

  if (!repo.isRepo) {
    fill(
      wrap,
      h(
        "div",
        { class: "panel-empty" },
        h("div", { class: "panel-empty-title" }, "Not a Git Repository"),
        h("div", { class: "panel-empty-text" }, repo.unavailableReason ?? "This folder is not a repository."),
        h(
          "button",
          {
            class: "btn btn--primary",
            onClick: () =>
              void api
                .gitInit()
                .then(() => {
                  toast("Repository initialized.", "success");
                  refreshScm();
                })
                .catch((e) => toast(String(e), "error")),
          },
          h("span", null, "Initialize Repository"),
        ),
      ),
    );
    return;
  }

  const staged = repo.entries.filter((e) => e.staged);
  const unstaged = repo.entries.filter((e) => !e.staged);

  fill(
    wrap,
    // Branch header
    h(
      "div",
      { class: "scm-branch" },
      h(
        "button",
        {
          class: "scm-branch-name",
          title: "Checkout a branch…",
          onClick: (e: MouseEvent) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            void showBranchMenu(rect.left, rect.bottom, repo!);
          },
        },
        icons.gitBranch(13),
        h("span", null, repo.branch ?? "HEAD"),
        repo.detached ? h("span", { class: "scm-detached" }, "detached") : null,
      ),
      h(
        "div",
        { class: "scm-branch-stats" },
        repo.upstream
          ? h(
              "span",
              { class: "scm-sync", title: `${repo.ahead} ahead, ${repo.behind} behind ${repo.upstream}` },
              repo.ahead > 0 ? `↑${repo.ahead}` : "",
              repo.behind > 0 ? `↓${repo.behind}` : "",
              repo.ahead === 0 && repo.behind === 0 ? "in sync" : "",
            )
          : h("span", { class: "scm-sync" }, "no upstream"),
        h(
          "button",
          {
            class: "icon-btn",
            title: "Pull",
            onClick: () => void runGit("Pull", () => api.gitPull()),
          },
          icons.download(13),
        ),
        h(
          "button",
          {
            class: "icon-btn",
            title: "Push",
            onClick: () => void runGit("Push", () => api.gitPush()),
          },
          icons.arrowRight(13),
        ),
      ),
    ),

    commitBox(),

    repo.hasConflicts
      ? h(
          "div",
          { class: "scm-conflict" },
          icons.warning(13),
          h("span", null, "There are unresolved merge conflicts."),
        )
      : null,

    staged.length
      ? scmSection("Staged Changes", staged, true)
      : null,
    unstaged.length
      ? scmSection("Changes", unstaged, false)
      : null,

    repo.entries.length === 0
      ? h(
          "div",
          { class: "panel-empty panel-empty--compact" },
          h("div", { class: "panel-empty-text" }, "Your working tree is clean."),
        )
      : null,

    commits.length ? commitHistory() : null,
  );
}

function commitBox(): HTMLElement {
  const input = h("input", {
    class: "scm-commit-input",
    type: "text",
    placeholder: "Message (Ctrl+Enter to commit)",
    spellcheck: false,
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void doCommit(input.value);
      }
    },
  }) as HTMLInputElement;

  return h(
    "div",
    { class: "scm-commit" },
    input,
    h(
      "button",
      {
        class: "btn btn--primary scm-commit-btn",
        title: "Commit staged changes",
        onClick: () => void doCommit(input.value),
      },
      icons.gitCommit(12),
      h("span", null, "Commit"),
    ),
  );
}

async function doCommit(message: string): Promise<void> {
  if (!message.trim()) {
    toast("Enter a commit message first.", "info");
    return;
  }
  const staged = repo?.entries.filter((e) => e.staged) ?? [];
  if (staged.length === 0) {
    toast("Stage some changes first.", "info");
    return;
  }
  try {
    const hash = await api.gitCommit(message);
    toast(`Committed ${hash}.`, "success");
    refreshScm();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

function scmSection(title: string, entries: StatusEntry[], staged: boolean): HTMLElement {
  return h(
    "div",
    { class: "scm-section" },
    h(
      "div",
      { class: "scm-section-head" },
      h("span", { class: "scm-section-title" }, `${title} (${entries.length})`),
      h(
        "div",
        { class: "scm-section-actions" },
        h(
          "button",
          {
            class: "icon-btn",
            title: staged ? "Unstage all" : "Stage all",
            onClick: () => {
              const paths = entries.map((e) => e.path);
              void runGit(staged ? "Unstage" : "Stage", () =>
                staged ? api.gitUnstage(paths) : api.gitStage(paths),
              );
            },
          },
          staged ? icons.minus(12) : icons.plus(12),
        ),
      ),
    ),
    ...entries.slice(0, 300).map((entry) => scmRow(entry, staged)),
    entries.length > 300
      ? h("div", { class: "scm-more" }, `… ${entries.length - 300} more`)
      : null,
  );
}

function scmRow(entry: StatusEntry, staged: boolean): HTMLElement {
  const statusLetter = entry.status === "untracked" ? "U" : entry.status.charAt(0).toUpperCase();
  return h(
    "div",
    {
      class: `scm-row scm-row--${entry.status}`,
      onClick: () => void openFile(entry.path, { preview: true }),
      onContextmenu: (e: MouseEvent) => {
        e.preventDefault();
        showEntryMenu(e.clientX, e.clientY, entry, staged);
      },
    },
    h(
      "button",
      {
        class: "scm-stage",
        title: staged ? "Unstage" : "Stage",
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          void runGit(staged ? "Unstage" : "Stage", () =>
            staged ? api.gitUnstage([entry.path]) : api.gitStage([entry.path]),
          );
        },
      },
      h("span", { class: `scm-status scm-status--${entry.status}` }, statusLetter),
    ),
    h("span", { class: "scm-path" }, entry.path.split("/").pop()),
    entry.originalPath
      ? h("span", { class: "scm-rename" }, `← ${entry.originalPath.split("/").pop()}`)
      : null,
    h(
      "button",
      {
        class: "scm-diff-btn",
        title: "Open the diff",
        onClick: async (e: MouseEvent) => {
          e.stopPropagation();
          try {
            const d = await api.gitDiff(entry.path, staged);
            if (!d.patch) {
              // Untracked files have no diff; synthesise one against empty.
              const after = (await readForDiff(entry.path)) ?? "";
              openDiff({ path: entry.path, before: "", after, isNew: true });
              return;
            }
            const current = (await readForDiff(entry.path)) ?? "";
            const before = entry.status === "added" ? "" : current;
            openDiff({
              path: entry.path,
              before,
              after: current,
              title: `${staged ? "Staged" : "Working tree"}: ${entry.path.split("/").pop()}`,
            });
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), "error");
          }
        },
      },
      icons.split(12),
    ),
  );
}

async function readForDiff(path: string): Promise<string | null> {
  try {
    const f = await api.readFile(path);
    return f.content ?? null;
  } catch {
    return null;
  }
}

function showEntryMenu(x: number, y: number, entry: StatusEntry, staged: boolean): void {
  const items: MenuItem[] = [
    { label: "Open File", icon: icons.file, run: () => void openFile(entry.path, { preview: true }) },
    { label: "Open Changes", icon: icons.split, run: () => void showGitDiff(entry, staged) },
    { label: "Copy Path", icon: icons.copy, run: () => void navigator.clipboard.writeText(entry.path) },
    { separator: true, label: "" },
    staged
      ? { label: "Unstage Changes", icon: icons.minus, run: () => void runGit("Unstage", () => api.gitUnstage([entry.path])) }
      : { label: "Stage Changes", icon: icons.plus, run: () => void runGit("Stage", () => api.gitStage([entry.path])) },
  ];
  if (!staged && entry.status !== "untracked") {
    items.push({
      label: "Discard Changes",
      icon: icons.trash,
      danger: true,
      run: () => void confirmDiscard(entry.path),
    });
  }
  openMenu(x, y, items);
}

async function showGitDiff(entry: StatusEntry, staged: boolean): Promise<void> {
  try {
    const d = await api.gitDiff(entry.path, staged);
    if (d.isBinary) {
      toast("This is a binary file; there is no text diff.", "info");
      return;
    }
    // Render the unified patch itself when we cannot get both sides cheaply.
    if (!d.patch) {
      const after = (await readForDiff(entry.path)) ?? "";
      openDiff({ path: entry.path, before: "", after, isNew: true, title: `New: ${entry.path.split("/").pop()}` });
      return;
    }
    const before = (await readForDiff(entry.path)) ?? "";
    openDiff({ path: entry.path, before, after: before, title: `Patch: ${entry.path.split("/").pop()}` });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function confirmDiscard(path: string): Promise<void> {
  if (!window.confirm(`Discard all changes to ${path.split("/").pop()}?\n\nThis cannot be undone.`)) return;
  try {
    await api.gitDiscard(path);
    toast("Changes discarded.", "success");
    refreshScm();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

function commitHistory(): HTMLElement {
  return h(
    "details",
    { class: "scm-commits" },
    h("summary", null, `Recent commits (${commits.length})`),
    ...commits.slice(0, 25).map((c) =>
      h(
        "div",
        { class: "scm-commit-row", title: `${c.hash} · ${c.author} · ${c.relativeDate}` },
        icons.gitCommit(11),
        h("span", { class: "scm-commit-subject" }, c.subject),
        h("span", { class: "scm-commit-hash mono" }, c.hash),
      ),
    ),
  );
}

async function showBranchMenu(x: number, y: number, _status: RepoStatus): Promise<void> {
  try {
    const branches = await api.gitBranches();
    const items: MenuItem[] = [
      {
        label: "Create a new branch…",
        icon: icons.plus,
        run: () => {
          const name = window.prompt("Name for the new branch:", "feature/");
          if (!name) return;
          void runGit("Create branch", () => api.gitCreateBranch(name));
        },
      },
      { separator: true, label: "" },
      ...branches.slice(0, 40).map(([name, isCurrent]) => ({
        label: isCurrent ? `● ${name}` : name,
        icon: isCurrent ? undefined : icons.gitBranch,
        disabled: isCurrent,
        run: () => void runGit("Checkout", () => api.gitCheckout(name)),
      })),
    ];
    openMenu(x, y, items);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function runGit(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    refreshScm();
    if (typeof result === "string" && result.trim()) {
      toast(result.trim().split("\n").slice(-2).join(" "), "success");
    } else {
      toast(`${label} done.`, "success");
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

// ===========================================================================
// Run
// ===========================================================================

let runMounted = false;

export function renderRun(host: HTMLElement): void {
  if (runMounted) return;
  runMounted = true;

  const shells = store.state.settings?.terminal.shell ?? "";

  fill(
    host,
    h(
      "div",
      { class: "run-wrap" },
      h(
        "div",
        { class: "run-section" },
        h("div", { class: "run-section-title" }, "NEW TERMINAL"),
        h(
          "button",
          {
            class: "run-item",
            onClick: () => {
              store.update((s) => {
                s.bottomPanel = "terminal";
              });
              window.dispatchEvent(new CustomEvent("ducky:new-terminal"));
            },
          },
          icons.terminal(14),
          h("span", null, "Create a new terminal"),
        ),
        h("div", { class: "run-shell" }, h("span", { class: "run-shell-label" }, "Shell:"), h("span", { class: "mono" }, shells.split("/").pop() ?? shells)),
      ),
      h(
        "div",
        { class: "run-section" },
        h("div", { class: "run-section-title" }, "DUCKY AI"),
        ...(["explain", "fix", "refactor", "tests", "optimize"] as QuickAction[]).map((action) =>
          h(
            "button",
            {
              class: "run-item",
              title: "Runs against the current selection or file",
              onClick: () => void runQuickAction(action),
            },
            icons.sparkle(14),
            h("span", null, aiActionLabel(action)),
          ),
        ),
        h(
          "button",
          {
            class: "run-item",
            onClick: () => void runQuickAction("command"),
          },
          icons.terminal(14),
          h("span", null, "Suggest a command…"),
        ),
      ),
      h(
        "div",
        { class: "run-section" },
        h("div", { class: "run-section-title" }, "PROBLEMS"),
        h(
          "button",
          {
            class: "run-item",
            onClick: () => store.update((s) => { s.bottomPanel = "problems"; }),
          },
          icons.problems(14),
          h("span", null, `Show problems (${store.state.problems.length})`),
        ),
      ),
    ),
  );
}

function aiActionLabel(action: QuickAction): string {
  switch (action) {
    case "explain": return "Explain the selection";
    case "fix": return "Fix the selected code";
    case "refactor": return "Refactor the selection";
    case "tests": return "Generate tests";
    case "optimize": return "Make this faster";
    default: return action;
  }
}

// ===========================================================================
// Extensions
// ===========================================================================

interface ExtensionInfo {
  id: string;
  name: string;
  description: string;
  sizeKb: number;
  memoryKb: number;
  enabled: boolean;
  lowMemoryCompatible: boolean;
  builtin: boolean;
  kind: string;
}

const BUILTIN_EXTENSIONS: ExtensionInfo[] = [
  {
    id: "ducky.ai",
    name: "Ducky AI",
    description:
      "The built-in assistant: chat, inline edits, autocomplete and agent mode. Inference runs on your configured remote provider, so no model is loaded on this machine.",
    sizeKb: 0,
    memoryKb: 0,
    enabled: true,
    lowMemoryCompatible: true,
    builtin: true,
    kind: "AI",
  },
  {
    id: "ducky.legacy-modes",
    name: "Syntax Highlighting",
    description:
      "Lightweight regex-based highlighters for more than 30 languages. Loaded one language at a time, on demand, so only the grammars you actually open stay in memory.",
    sizeKb: 0,
    memoryKb: 0,
    enabled: true,
    lowMemoryCompatible: true,
    builtin: true,
    kind: "Language",
  },
  {
    id: "ducky.diagnostics",
    name: "Ducky Diagnostics",
    description:
      "Bracket, quote, merge-marker and Python indentation checks. Runs in the editor process instead of spawning a language server, which is what keeps memory low.",
    sizeKb: 0,
    memoryKb: 0,
    enabled: true,
    lowMemoryCompatible: true,
    builtin: true,
    kind: "Linting",
  },
];

let extMounted = false;
let disabledBuiltins = new Set<string>();
let selection = "all";

export function renderExtensions(host: HTMLElement): void {
  if (!extMounted) {
    extMounted = true;
    buildExtensions(host);
  }
  paintExtensions();
}

function buildExtensions(host: HTMLElement): void {
  host.appendChild(
    h(
      "div",
      { class: "ext-wrap" },
      h(
        "div",
        { class: "ext-toolbar" },
        h("input", {
          class: "ext-filter",
          type: "text",
          placeholder: "Search extensions",
          spellcheck: false,
          onInput: (e: Event) => {
            (e.target as HTMLElement).dataset.filter = (e.target as HTMLInputElement).value.toLowerCase();
            paintExtensions();
          },
        }),
        h(
          "div",
          { class: "ext-filters" },
          ...(["all", "enabled", "disabled"] as const).map((f) =>
            h(
              "button",
              {
                class: "ext-filter-btn",
                dataset: { value: f },
                onClick: () => {
                  selection = f;
                  paintExtensions();
                },
              },
              f === "all" ? "All" : f === "enabled" ? "Enabled" : "Disabled",
            ),
          ),
        ),
      ),
      h(
        "div",
        {
          class: "ext-note",
        },
        icons.info(12),
        h(
          "span",
          null,
          "Extensions are opt-in. Ducky Coder Lite does not load third-party extensions automatically, and any extension marked ",
          h("strong", null, "Low Memory Compatible"),
          " has been built to avoid long-lived background processes and unbounded caches.",
        ),
      ),
      h("div", { class: "ext-list" }),
    ),
  );
}

function paintExtensions(): void {
  const list = document.querySelector<HTMLElement>(".ext-list");
  if (!list) return;
  const filter = (document.querySelector<HTMLElement>(".ext-filter")?.dataset.filter ?? "").toLowerCase();

  document.querySelectorAll<HTMLElement>(".ext-filter-btn").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.value === selection);
  });

  const all = BUILTIN_EXTENSIONS.map((e) => ({
    ...e,
    enabled: e.enabled && !disabledBuiltins.has(e.id),
  })).filter((e) => {
    if (selection === "enabled" && !e.enabled) return false;
    if (selection === "disabled" && e.enabled) return false;
    if (filter && !(`${e.name} ${e.description}`.toLowerCase().includes(filter))) return false;
    return true;
  });

  if (all.length === 0) {
    fill(list, h("div", { class: "panel-empty" }, h("div", { class: "panel-empty-text" }, "No extensions match.")));
    return;
  }

  fill(
    list,
    ...all.map((e) =>
      h(
        "div",
        { class: `ext-card${e.enabled ? "" : " is-disabled"}` },
        h(
          "div",
          { class: "ext-head" },
          h("span", { class: "ext-name" }, e.name),
          h("span", { class: "ext-kind" }, e.kind),
          e.lowMemoryCompatible ? h("span", { class: "ext-badge" }, "Low Memory Compatible") : null,
          h(
            "button",
            {
              class: `ext-toggle${e.enabled ? " is-on" : ""}`,
              title: e.enabled ? "Disable" : "Enable",
              onClick: () => {
                if (e.enabled) disabledBuiltins.add(e.id);
                else disabledBuiltins.delete(e.id);
                paintExtensions();
                toast(`${e.name} ${e.enabled ? "disabled" : "enabled"}.`, "success");
              },
            },
            h("span", { class: "ext-toggle-knob" }),
          ),
        ),
        h("div", { class: "ext-desc" }, e.description),
        h(
          "div",
          { class: "ext-meta" },
          h("span", null, `Memory: ${e.memoryKb ? `${e.memoryKb} KB` : "in-process, negligible"}`),
          h("span", null, `Size: ${e.sizeKb ? `${e.sizeKb} KB` : "built in"}`),
          h("span", null, e.builtin ? "Built-in" : "Third party"),
        ),
      ),
    ),
    h(
      "div",
      { class: "ext-foot" },
      "Third-party extensions are not installed by this build. Ducky Coder Lite's extension host is intentionally minimal so that a badly behaved extension cannot consume unbounded memory.",
    ),
  );
}

// ===========================================================================
// Problems
// ===========================================================================

export function renderProblems(host: HTMLElement, s: State): void {
  const errors = s.problems.filter((p) => p.severity === "error");
  const warnings = s.problems.filter((p) => p.severity === "warning");
  const infos = s.problems.filter((p) => p.severity === "info");

  if (s.problems.length === 0) {
    fill(
      host,
      h(
        "div",
        { class: "panel-empty panel-empty--compact" },
        h("div", { class: "panel-empty-title" }, "No problems detected"),
        h(
          "div",
          { class: "panel-empty-text" },
          "Ducky Coder Lite checks brackets, quotes, merge markers, Python indentation and TODO comments. It does not run a full compiler or language server, because those are what make an editor heavy.",
        ),
      ),
    );
    return;
  }

  const group = (title: string, items: State["problems"]): HTMLElement =>
    items.length
      ? h(
          "div",
          { class: "problems-group" },
          h("div", { class: "problems-group-title" }, `${title} (${items.length})`),
          ...items.slice(0, 200).map((p) =>
            h(
              "div",
              { class: `problem problem--${p.severity}` },
              h(
                "button",
                {
                  class: "problem-main",
                  onClick: () => {
                    void openFile(p.file, { preview: true });
                    queueMicrotask(() => {
                      window.dispatchEvent(
                        new CustomEvent("ducky:reveal", { detail: { path: p.file, line: p.line, column: p.column } }),
                      );
                    });
                  },
                },
                h("span", { class: "problem-icon" }, p.severity === "error" ? icons.error(12) : p.severity === "warning" ? icons.warning(12) : icons.info(12)),
                h("span", { class: "problem-message" }, p.message),
                h("span", { class: "problem-source" }, p.source),
              ),
              h("span", { class: "problem-location mono" }, `${p.file.split("/").pop()}[${p.line}:${p.column}]`),
              p.severity === "error"
                ? h(
                    "button",
                    {
                      class: "problem-ai",
                      title: "Ask Ducky AI to fix this",
                      onClick: () => void fixProblem(p),
                    },
                    icons.sparkle(12),
                    h("span", null, "Ask Ducky AI to Fix"),
                  )
                : null,
            ),
          ),
        )
      : h("div");

  fill(host, group("Errors", errors), group("Warnings", warnings), group("Information", infos));
}

/** "Ask Ducky AI to Fix" sends the error and the surrounding code, nothing more. */
async function fixProblem(p: State["problems"][number]): Promise<void> {
  try {
    const file = await api.readFile(p.file);
    if (!file.content) {
      toast("Could not read that file.", "error");
      return;
    }
    const lines = file.content.split("\n");
    const from = Math.max(0, p.line - 12);
    const to = Math.min(lines.length, p.line + 12);
    const excerpt = lines.slice(from, to).join("\n");

    store.update((s) => {
      s.aiPanelVisible = true;
      s.pinnedContext = [...new Set([...s.pinnedContext, p.file])];
    });

    await api.aiCompleteTask(
      `fix-${Date.now()}`,
      `There is an error in ${p.file} at line ${p.line}, column ${p.column}:\n\n` +
        `${p.severity}: ${p.message}\n\n` +
        `The code around the error:\n${excerpt}\n\n` +
        `Fix this. Explain the cause in one sentence, then give the corrected code.`,
      excerpt,
      p.file,
      false,
    );

    // The result is shown through the normal inline-AI review path.
    await runQuickAction("fix");
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

export { escapeHtml, formatBytes, clear, confirmCommand };
