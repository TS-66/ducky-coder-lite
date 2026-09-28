/**
 * The icon set.
 *
 * All icons are hand-authored SVG paths on a 16×16 grid, drawn as strokes so
 * they stay crisp at any DPI and cost almost nothing to render. They are
 * original shapes: simple, geometric, consistent in weight.
 *
 * Why hand-authored rather than an icon font: a webfont means a network request
 * (or a multi-hundred-kilobyte base64 blob) at startup, extra layout work and a
 * permanently resident font. Inline SVG path data is a few hundred bytes per
 * icon and renders in the same pass as the DOM around it.
 */

import { svg } from "../core/dom";

const NS = "http://www.w3.org/2000/svg";

function icon(paths: string[], opts: { fill?: boolean; size?: number } = {}): SVGElement {
  const s = opts.size ?? 16;
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", String(s));
  el.setAttribute("height", String(s));
  el.setAttribute("fill", "none");
  el.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.3");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    if (opts.fill) {
      p.setAttribute("fill", "currentColor");
      p.setAttribute("stroke-width", "1");
    }
    el.appendChild(p);
  }
  return el;
}

/** The Ducky mark: a stylised duck head, used in the activity bar and welcome. */
function duckMark(size = 16): SVGElement {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("fill", "none");
  el.setAttribute("aria-hidden", "true");

  const body = document.createElementNS(NS, "path");
  // Head and beak, a single continuous stroke.
  body.setAttribute(
    "d",
    "M4 14c0-3.3 2.7-6 6-6h1.2c1.6 0 2.9 1 3.4 2.4l1.1 3.1c.3.8-.3 1.5-1.1 1.5H13a7 7 0 0 1-7 5",
  );
  body.setAttribute("stroke", "currentColor");
  body.setAttribute("stroke-width", "1.6");
  body.setAttribute("stroke-linecap", "round");
  body.setAttribute("stroke-linejoin", "round");
  el.appendChild(body);

  // The bill.
  const bill = document.createElementNS(NS, "path");
  bill.setAttribute("d", "M15.6 10.2h4.2c.6 0 1 .5.9 1.1l-.3 1.5c-.1.5-.5.8-1 .8h-3.6");
  bill.setAttribute("stroke", "currentColor");
  bill.setAttribute("stroke-width", "1.6");
  bill.setAttribute("stroke-linecap", "round");
  bill.setAttribute("stroke-linejoin", "round");
  el.appendChild(bill);

  // The eye.
  const eye = document.createElementNS(NS, "circle");
  eye.setAttribute("cx", "11.4");
  eye.setAttribute("cy", "9.6");
  eye.setAttribute("r", "1.05");
  eye.setAttribute("fill", "currentColor");
  el.appendChild(eye);

  return el;
}

export const icons = {
  duck: duckMark,

  explorer: (s?: number) =>
    icon(
      [
        "M1.8 3.2h4.1l1 1.3h7.3v8.3H1.8z",
        "M1.8 3.2v9.6",
      ],
      { size: s },
    ),

  search: (s?: number) =>
    icon(["M7 12.2A5.2 5.2 0 1 0 7 1.8a5.2 5.2 0 0 0 0 10.4z", "M10.8 10.8 14 14"], { size: s }),

  // Source control: a branch topology. The previous version drew to x=16.4 in a
  // 0 0 16 16 viewBox, so the outer arc was clipped and the icon rendered as a
  // stray squiggle.
  scm: (s?: number) =>
    icon(
      [
        "M3.5 4.2a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
        "M3.5 11.8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
        "M10 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
        "M5 5.7v4.6",
        "M5 8h5",
      ],
      { size: s },
    ),

  run: (s?: number) =>
    icon(["M5 3.2 12.8 8 5 12.8z", "M4 2.6h-.9", "M12 13.4h.9"], { size: s, fill: false }),

  extensions: (s?: number) =>
    icon(
      [
        "M6.4 2.4h3.2v2a1.2 1.2 0 0 0 2.4 0v-2h.1v3.9a1.1 1.1 0 0 1-1.1 1.1H9v.1a1.1 1.1 0 0 1-1.1 1.1H6.4V2.4z",
        "M2.4 9.2h4.4v3.9H2.4z",
        "M9.2 9.2h4.4v3.9H9.2z",
      ],
      { size: s },
    ),

  terminal: (s?: number) =>
    icon(["M2.6 3.6h10.8v8.8H2.6z", "M4.8 6.6 6.8 8l-2 1.4", "M8.4 9.8h3"], { size: s }),

  problems: (s?: number) => icon(["M8 2.2 14.2 13H1.8z", "M8 6.4v3.1", "M8 11.1v.05"], { size: s }),

  chat: (s?: number) =>
    icon(
      [
        "M13.8 9.4a1.6 1.6 0 0 1-1.6 1.6H5.6L2.6 13.4V4.2a1.6 1.6 0 0 1 1.6-1.6h8a1.6 1.6 0 0 1 1.6 1.6z",
        "M5.6 6.2h4.8",
        "M5.6 8.6h3.2",
      ],
      { size: s },
    ),

  settings: (s?: number) =>
    icon(
      [
        "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z",
        "M12.9 10.2a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.67 1v.11a1.33 1.33 0 1 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1-.67h-.11a1.33 1.33 0 1 1 0-2.66h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .67-1v-.11a1.33 1.33 0 0 1 2.66 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1 .67h.11a1.33 1.33 0 0 1 0 2.66h-.06a1.1 1.1 0 0 0-1 .67z",
      ],
      { size: s },
    ),

  // A notebook: a spine with a folded corner and three rules.
  notepad: (s?: number) =>
    icon(
      [
        "M3.4 2.6h6.2L13 6v7.4H3.4Z",
        "M9.6 2.6V6H13",
        "M5.6 8.4h4.8",
        "M5.6 10.6h4.8",
      ],
      { size: s },
    ),
  chevronRight: (s?: number) => icon(["M6 3.4 10.6 8 6 12.6"], { size: s }),
  chevronLeft: (s?: number) => icon(["M10 3.4 5.4 8 10 12.6"], { size: s }),
  chevronDown: (s?: number) => icon(["M3.4 6 8 10.6 12.6 6"], { size: s }),
  close: (s?: number) => icon(["M3.8 3.8 12.2 12.2", "M12.2 3.8 3.8 12.2"], { size: s }),
  check: (s?: number) => icon(["M3 8.4 6.4 11.8 13 4.6"], { size: s }),
  plus: (s?: number) => icon(["M8 3.2v9.6", "M3.2 8h9.6"], { size: s }),
  minus: (s?: number) => icon(["M3.2 8h9.6"], { size: s }),
  refresh: (s?: number) =>
    icon(["M13.4 8a5.4 5.4 0 1 1-1.6-3.8", "M13.6 2.4v3.4h-3.4"], { size: s }),
  folder: (s?: number) => icon(["M1.8 3.6h4.3l1 1.3h7.1v7.5H1.8z"], { size: s }),
  folderOpen: (s?: number) => icon(["M1.8 12.2V3.6h4.3l1 1.3h7.1v2", "M1.8 12.2l1.9-5.3h11l-1.9 5.3z"], { size: s }),
  file: (s?: number) => icon(["M3.4 1.8h6l3.2 3.2v9.2H3.4z", "M9.4 1.8v3.2h3.2"], { size: s }),
  trash: (s?: number) => icon(["M2.8 4.2h10.4", "M5.6 4.2V2.8h4.8v1.4", "M4.2 4.2l.7 9.2h6.2l.7-9.2", "M6.6 6.4v5", "M9.4 6.4v5"], { size: s }),
  edit: (s?: number) => icon(["M2.6 13.4h3l7.6-7.6-3-3-7.6 7.6z", "M10.4 2.8l3 3"], { size: s }),
  split: (s?: number) => icon(["M2.6 3.4h10.8v9.2H2.6z", "M10 3.4v9.2"], { size: s }),
  warning: (s?: number) => icon(["M8 2.2 14.2 13H1.8z", "M8 6.4v3.1", "M8 11.1v.05"], { size: s }),
  error: (s?: number) => icon(["M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8z", "M8 5v3.6", "M8 10.8v.05"], { size: s }),
  info: (s?: number) => icon(["M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8z", "M8 7.4v3.8", "M8 4.9v.05"], { size: s }),
  sparkle: (s?: number) =>
    icon(
      [
        "M8 1.8 9.4 6 13.6 7.4 9.4 8.8 8 13 6.6 8.8 2.4 7.4 6.6 6z",
        "M12.4 10.6l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z",
      ],
      { size: s },
    ),
  send: (s?: number) => icon(["M2.4 8 13.6 2.6 10.4 13.4 8 9.6z", "M8 9.6 13.6 2.6"], { size: s }),
  stop: (s?: number) => icon(["M4.4 4.4h7.2v7.2H4.4z"], { size: s }),
  copy: (s?: number) => icon(["M5.6 5.6h7.6v7.6H5.6z", "M2.8 10.4V2.8h7.6"], { size: s }),
  gitBranch: (s?: number) =>
    icon(["M4.6 3.2v9.6", "M4.6 4.4a1 1 0 1 0 0-.05", "M4.6 12.8a1 1 0 1 0 0-.05", "M11.4 3.2a1 1 0 1 0 0-.05", "M11.4 4.2v1.4a2 2 0 0 1-2 2H6.6"], { size: s }),
  gitCommit: (s?: number) => icon(["M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z", "M2.6 8h2.6", "M10.8 8h2.6"], { size: s }),
  box: (s?: number) => icon(["M8 1.8 14.2 5v6L8 14.2 1.8 11V5z", "M1.8 5 8 8.2 14.2 5", "M8 8.2v6"], { size: s }),
  cpu: (s?: number) =>
    icon(
      [
        "M4.6 4.6h6.8v6.8H4.6z",
        "M6.4 1.8v2.8",
        "M9.6 1.8v2.8",
        "M6.4 11.4v2.8",
        "M9.6 11.4v2.8",
        "M1.8 6.4h2.8",
        "M1.8 9.6h2.8",
        "M11.4 6.4h2.8",
        "M11.4 9.6h2.8",
      ],
      { size: s },
    ),
  memory: (s?: number) =>
    icon(["M4.4 5.2h7.2v5.6H4.4z", "M2.6 7h1.8", "M2.6 9h1.8", "M6.4 3.2v2", "M8 3.2v2", "M9.6 3.2v2", "M6.4 10.8v2", "M8 10.8v2", "M9.6 10.8v2"], { size: s }),
  bolt: (s?: number) => icon(["M9.2 1.8 4 8.8h3.4l-.6 5.4 5.2-7H8.6z"], { size: s }),
  eye: (s?: number) => icon(["M1.8 8S4.4 3.6 8 3.6 14.2 8 14.2 8 11.6 12.4 8 12.4 1.8 8 1.8 8z", "M9.8 8a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0z"], { size: s }),
  pin: (s?: number) => icon(["M6.2 1.8h3.6v3l2.2 2.6H4L6.2 4.8z", "M8 7.4v6.8"], { size: s }),
  arrowLeft: (s?: number) => icon(["M12.6 8H3.4", "M6.8 4.6 3.4 8l3.4 3.4"], { size: s }),
  arrowRight: (s?: number) => icon(["M3.4 8h9.2", "M9.2 4.6 12.6 8l-3.4 3.4"], { size: s }),
  history: (s?: number) => icon(["M2.4 8a5.6 5.6 0 1 0 1.7-4", "M2.4 2.4v3.4h3.4", "M8 5v3.3l2.4 1.4"], { size: s }),
  download: (s?: number) => icon(["M8 2.4v7.4", "M4.8 7l3.2 3.2L11.2 7", "M2.6 12.8h10.8"], { size: s }),
};

/**
 * File-type icons.
 *
 * Returned as a short two/three-letter monogram rather than a unique glyph per
 * language: a hundred hand-drawn file icons would be a hundred SVG paths in the
 * bundle, and a colour-coded monogram is what several editors do for exactly
 * this reason. It also keeps the explorer's DOM cheap.
 */
const LANG_INITIALS: Record<string, string> = {
  rust: "RS", typescript: "TS", tsx: "TSX", javascript: "JS", jsx: "JSX",
  json: "{}", json5: "5", python: "PY", lua: "LUA", ruby: "RB", go: "GO",
  java: "JV", kotlin: "KT", c: "C", cpp: "C++", csharp: "C#", swift: "SW",
  php: "PHP", shell: "SH", fish: "SH", powershell: "PS", batch: "CMD",
  sql: "SQL", html: "<>", css: "CSS", sass: "SASS", less: "LESS", vue: "VU",
  svelte: "SV", markdown: "MD", yaml: "YML", toml: "TM", ini: "CFG",
  xml: "<>", dockerfile: "DK", graphql: "GQ", protobuf: "PB", terraform: "TF",
  zig: "ZG", elixir: "EX", erlang: "ER", haskell: "HS", ocaml: "ML",
  clojure: "CL", scala: "SC", dart: "DA", r: "R", julia: "JL", asm: "ASM",
  diff: "DIFF", text: "TXT", plaintext: "TXT", dotenv: "ENV",
  gitignore: "GIT", lockfile: "LOCK", cmake: "CM", makefile: "MK",
};

const LANG_COLORS: Record<string, string> = {
  rust: "#e8937a", typescript: "#6aa9f0", tsx: "#6aa9f0", javascript: "#e8d44d",
  json: "#c4b5e8", python: "#7cc4f0", lua: "#7fa8d8", ruby: "#e0605e",
  go: "#69c8d2", java: "#e08b6a", kotlin: "#b07ad8", c: "#8fb8d8",
  cpp: "#8fb8d8", csharp: "#7fb8e0", swift: "#e8935c", php: "#9a8fd0",
  shell: "#a8d98a", powershell: "#6aa9f0", batch: "#a8b0a0", sql: "#d8a86a",
  html: "#e8935c", css: "#6a9ee0", sass: "#e08b9e", less: "#6a9ee0",
  vue: "#69d2a0", svelte: "#e8935c", markdown: "#a8b8c8", yaml: "#c4a86a",
  toml: "#c4a86a", ini: "#a8b0a0", xml: "#d8a86a", dockerfile: "#6ab0d8",
  graphql: "#e07ab0", protobuf: "#8fd8c0", terraform: "#b08fe0", zig: "#e8c05c",
  elixir: "#b06ad8", erlang: "#d88a6a", haskell: "#b0d86a", clojure: "#6ad8b0",
  scala: "#e06a9e", dart: "#4ab8e8", r: "#7fb0d8", julia: "#b07ad8",
};

export function langMonogram(language: string): { text: string; color: string } {
  return {
    text: LANG_INITIALS[language] ?? "",
    color: LANG_COLORS[language] ?? "#6b7480",
  };
}

export { svg };
