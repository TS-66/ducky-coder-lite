/**
 * The diff view.
 *
 * Used in three places, all of which are the same interaction:
 *   * inline AI edit review (Accept / Reject / Accept All / Reject All);
 *   * reviewing a Git change;
 *   * reviewing a file the agent proposed.
 *
 * ## The diff algorithm
 *
 * A line-based Myers diff, computed here rather than pulled in. It matters for
 * the memory budget: a dependency would add tens of kilobytes to a bundle we
 * keep deliberately small, and this is the only diff the app ever draws. The
 * implementation works on a bounded window, so a very large change degrades to
 * a coarse diff rather than an O(n²) stall.
 */

import { h, fill, clear, escapeHtml } from "../core/dom";
import { icons } from "./icons";
import { openFile, store, toast } from "../core/store";

export type DiffOp = "context" | "add" | "del" | "mod";

export interface DiffLine {
  op: DiffOp;
  before: number | null;
  after: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/**
 * Compute a line diff.
 *
 * Uses the classic "common prefix / common suffix then LCS on the middle" split,
 * which is both fast and produces clean hunks for the edit-shaped diffs an AI
 * or a human actually makes. The LCS table is bounded so a pathological pair of
 * files cannot allocate a large matrix.
 */
export function diffLines(before: string, after: string): DiffHunk[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // Trim the common prefix and suffix: for an edit, that is nearly all of it.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: DiffOp[] = [];

  // Bound the LCS: past this size we fall back to "replace everything", which
  // is honest and instant.
  const MAX_CELLS = 4_000_000;
  if (midA.length * midB.length > MAX_CELLS) {
    ops.push(...midA.map(() => "del" as DiffOp), ...midB.map(() => "add" as DiffOp));
  } else {
    ops.push(...lcsDiff(midA, midB));
  }

  // Stitch prefix + middle + suffix into positioned lines.
  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++) {
    lines.push({ op: "context", before: i + 1, after: i + 1, text: a[i] });
  }
  let ai = start;
  let bi = start;
  for (const op of ops) {
    if (op === "context") {
      lines.push({ op, before: ai + 1, after: bi + 1, text: a[ai] ?? b[bi] ?? "" });
      ai++;
      bi++;
    } else if (op === "del") {
      lines.push({ op, before: ai + 1, after: null, text: a[ai] ?? "" });
      ai++;
    } else {
      lines.push({ op, before: null, after: bi + 1, text: b[bi] ?? "" });
      bi++;
    }
  }
  for (let i = 0; i < a.length - endA; i++) {
    lines.push({ op: "context", before: endA + i + 1, after: endB + i + 1, text: a[endA + i] });
  }

  return toHunks(lines);
}

/** Classic LCS over a bounded table. */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map(() => "add" as DiffOp);
  if (m === 0) return a.map(() => "del" as DiffOp);

  // A flat Uint32Array is far cheaper than a 2D array of numbers, and the
  // values we need are small.
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] =
        a[i] === b[j]
          ? table[(i + 1) * (m + 1) + (j + 1)]! + 1
          : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + (j + 1)]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push("context");
      i++;
      j++;
    } else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + (j + 1)]!) {
      ops.push("del");
      i++;
    } else {
      ops.push("add");
      j++;
    }
  }
  while (i < n) ops.push("del"), i++;
  while (j < m) ops.push("add"), j++;
  return ops;
}

/** Group lines into hunks with a small amount of context. */
function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.op !== "context") changed.push(i);
  }
  if (changed.length === 0) {
    // No change at all: show the head of the file so the view is not empty.
    return [
      {
        header: "@@ no changes @@",
        lines: lines.slice(0, Math.min(40, lines.length)),
      },
    ];
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < changed.length) {
    const first = Math.max(0, changed[i]! - context);
    // Extend while changes are within 2*context of each other.
    let last = changed[i]!;
    let k = i;
    while (k + 1 < changed.length && changed[k + 1]! - changed[k]! <= context * 2) {
      k++;
      last = changed[k]!;
    }
    const end = Math.min(lines.length, last + context + 1);
    const slice = lines.slice(first, end);

    const beforeCount = slice.filter((l) => l.before !== null).length;
    const afterCount = slice.filter((l) => l.after !== null).length;
    const beforeStart = slice.find((l) => l.before !== null)?.before ?? 0;
    const afterStart = slice.find((l) => l.after !== null)?.after ?? 0;

    hunks.push({
      header: `@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`,
      lines: slice,
    });
    i = k + 1;
  }
  return hunks;
}

export function diffStats(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.op === "add") additions++;
      else if (line.op === "del") deletions++;
    }
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface DiffRequest {
  path: string;
  before: string;
  after: string;
  /** "next" (apply) or "replace" (overwrite) decides the primary button. */
  mode?: "next" | "replace";
  /** True when the file does not exist yet, so `before` is empty. */
  isNew?: boolean;
  onAccept?: (after: string) => void;
  onReject?: () => void;
  title?: string;
}

export function openDiff(req: DiffRequest): void {
  const hunks = diffLines(req.before, req.after);
  const { additions, deletions } = diffStats(hunks);

  // A very large diff is a memory and legibility problem. Show the head of the
  // change and say plainly what was omitted, rather than rendering 40,000 rows.
  const MAX_RENDERED = 4_000;
  let rendered = hunks;
  let omitted = 0;
  let counted = 0;
  for (const hunk of hunks) counted += hunk.lines.length;
  if (counted > MAX_RENDERED) {
    rendered = [];
    let budget = MAX_RENDERED;
    for (const hunk of hunks) {
      if (budget <= 0) {
        omitted++;
        continue;
      }
      const take = hunk.lines.slice(0, budget);
      rendered.push({ header: hunk.header, lines: take });
      budget -= take.length;
      if (take.length < hunk.lines.length) omitted++;
    }
  }

  const overlay = h("div", {
    class: "modal-overlay diff-overlay",
    onClick: (e: MouseEvent) => {
      if (e.target === overlay) close();
    },
  });

  const body = h("div", { class: "diff-body" });

  const close = (): void => overlay.remove();

  const accept = (): void => {
    if (req.onAccept) req.onAccept(req.after);
    else {
      // Default: apply straight into the editor, as an unsaved change.
      const tab = store.state.tabs.find((t) => t.path === req.path);
      if (tab) {
        store.update((s) => {
          const t = s.tabs.find((x) => x.path === req.path);
          if (t) {
            t.content = req.after;
            t.dirty = true;
          }
        });
        toast(`Applied to ${req.path}. It is unsaved — review it, then save.`, "success");
      } else {
        void openFile(req.path, { preview: false });
        toast(`Opened ${req.path}. The change was not applied.`, "info");
      }
    }
    close();
  };

  const reject = (): void => {
    req.onReject?.();
    close();
  };

  overlay.appendChild(
    h(
      "div",
      { class: "modal diff-modal", role: "dialog", "aria-modal": "true" },
      h(
        "div",
        { class: "modal-head" },
        h("h2", { class: "modal-title" }, req.title ?? `Changes to ${shortName(req.path)}`),
        h(
          "div",
          { class: "diff-stats" },
          h("span", { class: "diff-stat-add" }, `+${additions}`),
          h("span", { class: "diff-stat-del" }, `−${deletions}`),
          h(
            "button",
            { class: "icon-btn", title: "Close", onClick: close },
            icons.close(13),
          ),
        ),
      ),
      h(
        "div",
        { class: "diff-path" },
        icons.file(12),
        h("span", { class: "mono" }, req.path),
      ),
      body,
      h(
        "div",
        { class: "modal-actions modal-actions--sticky" },
        h(
          "button",
          { class: "btn btn--primary", onClick: accept },
          icons.check(12),
          h("span", null, req.mode === "next" ? "Accept" : "Accept All"),
        ),
        h(
          "button",
          { class: "btn", onClick: reject },
          icons.close(12),
          h("span", null, req.mode === "next" ? "Reject" : "Reject All"),
        ),
        h("span", { class: "modal-note" }, "Nothing is written to disk until you save."),
      ),
    ),
  );

  for (const hunk of rendered) {
    body.appendChild(
      h(
        "div",
        { class: "diff-hunk" },
        h("div", { class: "diff-hunk-header mono" }, hunk.header),
        h(
          "div",
          { class: "diff-hunk-lines" },
          ...hunk.lines.map((line) =>
            h(
              "div",
              { class: `diff-line diff-line--${line.op}` },
              h("span", { class: "diff-gutter diff-gutter--before" }, line.before ?? ""),
              h("span", { class: "diff-gutter diff-gutter--after" }, line.after ?? ""),
              h("span", { class: "diff-sign" }, line.op === "add" ? "+" : line.op === "del" ? "−" : " "),
              h("span", { class: "diff-text" }, line.text || " "),
            ),
          ),
        ),
      ),
    );
  }

  if (omitted > 0) {
    body.appendChild(
      h(
        "div",
        { class: "diff-omitted" },
        `This change is very large. ${omitted} hunk${omitted === 1 ? "" : "s"} were not drawn, to keep Ducky Coder Lite responsive. The full change is still available if you accept it.`,
      ),
    );
  }

  document.body.appendChild(overlay);
}

function shortName(path: string): string {
  return path.split("/").pop() ?? path;
}

export { escapeHtml, clear, fill };
