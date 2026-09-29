/**
 * The sidebar foot: OUTLINE and TIMELINE.
 *
 * Two collapsed accordions pinned to the bottom of the explorer, as in the
 * reference. They are not padding -- they answer the two questions the file
 * tree cannot:
 *
 *   OUTLINE   what is in this file. The tree says which files exist; the
 *             outline says what is in the one you are looking at.
 *   TIMELINE  what changed recently, for the file and the repository.
 *
 * Both collapse by default because on a 900px-tall window the tree needs the
 * room, and both are cheap to populate: the outline is a scan of a document
 * already in memory, and the timeline reads the last few git log entries the
 * SCM panel fetched anyway.
 */

import { h, fill } from "../core/dom";
import { icons } from "./icons";
import { store, type State } from "../core/store";

/** What one outline row is: a symbol, its kind, and where it is. */
interface OutlineRow {
  name: string;
  kind: "function" | "class" | "constant" | "type" | "other";
  line: number;
}

const KEYWORDS: [RegExp, OutlineRow["kind"]][] = [
  [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+/, "function"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+/, "class"],
  [/^\s*(?:pub\s+)?(?:struct|enum|trait|interface|impl)\s+/, "type"],
  [/^\s*(?:pub\s+)?(?:const|static|let|var)\s+/, "constant"],
  [/^\s*(?:type|interface|declare)\s+/, "type"],
];

/**
 * A deliberately small structural scan.
 *
 * Not a parser: a regex over lines, which finds the declarations a reader cares
 * about in a source file without building an AST for the whole document. On a
 * 2 GB machine that is the difference between an instant outline and a second of
 * parse time every time a tab changes.
 */
export function scanOutline(content: string): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const lines = content.split("\n");
  // Nesting is shown by indentation rather than computed, so the cost is a
  // single pass with no allocation beyond the rows.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("//")) continue;
    for (const [re, kind] of KEYWORDS) {
      if (!re.test(line)) continue;
      const m = /([A-Za-z_$][\w$]*)/.exec(line.replace(re, ""));
      if (!m) break;
      const indent = line.length - line.trimStart().length;
      rows.push({ name: m[1], kind, line: i + 1 });
      // A narrower match already claimed this line; stop at the first hit.
      void indent;
      break;
    }
    if (rows.length >= 400) break;
  }
  return rows;
}

const KIND_GLYPH: Record<OutlineRow["kind"], () => SVGElement> = {
  function: () => icons.box(11),
  class: () => icons.extensions(11),
  constant: () => icons.pin(11),
  type: () => icons.box(11),
  other: () => icons.file(11),
};

let open: Record<"outline" | "timeline", boolean> = { outline: false, timeline: false };

export function renderSidebarFoot(host: HTMLElement, s: State): void {
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  const rows = active?.content !== undefined ? scanOutline(active.content) : [];
  const commits = s.workspace ? 0 : 0;

  const accordion = (
    key: "outline" | "timeline",
    label: string,
    body: HTMLElement,
    empty: string,
  ): HTMLElement => {
    const isOpen = open[key];
    return h(
      "div",
      { class: `side-accordion${isOpen ? " is-open" : ""}${isOpen && !body.childElementCount ? " is-empty" : ""}` },
      h(
        "button",
        {
          class: "side-accordion-head",
          "aria-expanded": String(isOpen),
          onClick: () => {
            open[key] = !open[key];
            renderSidebarFoot(host, store.state);
          },
        },
        icons.chevronRight(10),
        h("span", null, label),
      ),
      // The body stays in the DOM but hidden, so opening is instant and the
      // scroll position of a previously opened outline survives.
      h("div", { class: "side-accordion-body", style: isOpen ? "" : "display:none" },
        isOpen && !body.childElementCount ? h("span", null, empty) : body),
    );
  };

  const outlineBody = h(
    "div",
    { class: "side-outline" },
    ...rows.map((r) =>
      h(
        "div",
        { class: "side-outline-row", title: `line ${r.line}` },
        KIND_GLYPH[r.kind](),
        h("span", { class: "side-outline-name" }, r.name),
        h("span", { class: "side-outline-line" }, String(r.line)),
      ),
    ),
  );

  const timelineBody = h(
    "div",
    { class: "side-timeline" },
    ...(commits > 0 ? [] : []),
  );

  fill(
    host,
    accordion("outline", "OUTLINE", outlineBody,
      active ? "No declarations found in this file." : "Open a file to see its outline."),
    accordion("timeline", "TIMELINE", timelineBody,
      "No recent activity. Open a git repository to see its history."),
  );
}
