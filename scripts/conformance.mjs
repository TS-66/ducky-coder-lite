/**
 * Conformance against the reference screenshots.
 *
 * This exists because the app cannot be rendered to pixels in the environment
 * this was built in: headless Chromium hangs, and there is no compositor for a
 * real window. Rather than assert nothing, this checks the two things that can
 * be checked exactly and honestly:
 *
 *   1. **Colours** -- the palette, token by token, against the values sampled
 *      from `/mnt/chromeos/MyFiles/Downloads/ui/*.jpeg` and the written spec.
 *      A wrong hex is a fact, not a judgement call.
 *   2. **Geometry** -- the fixed widths and heights, which decide whether the
 *      layout *is* the reference layout.
 *
 * It also pins the component inventory: every element visible in the three
 * references must exist. That is what stops a rebuild from quietly dropping
 * half the UI while still looking plausible.
 *
 *   node scripts/conformance.mjs
 *
 * The colour values were measured, not chosen. JPEG at this quality lifts every
 * near-black to #191919, so surfaces are taken from the written specification,
 * while the diff colours -- saturated enough to survive the compression -- are
 * taken from the images.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const ASSETS = join(DIST, "assets");

let pass = 0;
let fail = 0;

const group = (name) => console.log(`\n── ${name}`);
const check = (label, ok, detail = "") => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? `  ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

/** The palette the references and the spec require. */
const REQUIRED_TOKENS = {
  // Measured from ui.3: 80%+ dominant inside each block.
  "--diff-del-bg": "#511c22",
  "--diff-add-bg": "#1f431f",
  // From the written specification.
  "--bg-editor": "#0b0b0c",
  "--bg-sidebar": "#121214",
  "--bg-activity": "#09090a",
  "--bg-terminal": "#050506",
  "--bg-raised": "#18181c",
  "--border": "#1f1f23",
  "--border-strong": "#26262b",
  "--border-input": "#2c2c32",
  "--accent": "#38bdf8",
  "--fg-strong": "#f4f4f6",
  "--fg-muted": "#8e8e93",
  "--gutter": "#3a3a3c",
  "--ghost": "#5a5a62",
  "--brand-purple": "#5d53e7",
  // Metrics: these decide the layout, not just its colour.
  "--h-title": "44px",
  "--w-activity": "48px",
  "--w-sidebar": "240px",
  "--w-ai": "380px",
  "--h-tab": "35px",
  "--h-status": "22px",
};

function tokenBlock(css) {
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    if (!(m[1] in out)) out[m[1]] = m[2].trim().toLowerCase();
  }
  return out;
}

function declValue(css, selector, prop) {
  // The last matching rule of equal specificity is the one that wins, so that is
  // the one to read. Reading the first masked a real defect: two `.ai-panel`
  // rules with different widths, where the earlier one was dead.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let found = null;
  while ((m = re.exec(css)) !== null) {
    if (!m[1].split(",").some((s) => s.trim() === selector)) continue;
    const pm = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(m[2]);
    if (pm) found = pm[1].trim().toLowerCase();
  }
  return found;
}

/** Every `.class` selector in the stylesheet. */
function classNamesIn(css) {
  const out = new Set();
  for (const m of css.matchAll(/\.([a-z][a-z0-9-]{2,})\s*(?=[,{:.\s>])/gi)) out.add(m[1]);
  return out;
}

function allFiles(dir, ext) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? allFiles(join(dir, d.name), ext) : [join(dir, d.name)],
  );
}

// ---------------------------------------------------------------------------

if (!existsSync(ASSETS)) {
  console.error("dist/ is missing. Run: npm run build");
  process.exit(2);
}

const cssFile = readdirSync(ASSETS).find((f) => f.endsWith(".css"));
if (!cssFile) {
  console.error("no stylesheet in dist/assets. Run: npm run build");
  process.exit(2);
}
const css = readFileSync(join(ASSETS, cssFile), "utf8");
const tokens = tokenBlock(css);

group("design tokens: measured and specified values");
for (const [token, expected] of Object.entries(REQUIRED_TOKENS)) {
  const actual = tokens[token];
  check(`${token} is ${expected}`, actual === expected, actual ? `got ${actual}` : "MISSING");
}

group("geometry: the columns are the reference columns");
check("activity dock is 48px", declValue(css, ".activity-bar", "width") === "var(--w-activity)",
  String(declValue(css, ".activity-bar", "width")));
check("AI panel is 380px", declValue(css, ".ai-panel", "width") === "var(--w-ai)",
  String(declValue(css, ".ai-panel", "width")));
check("title bar is 44px", declValue(css, ".title-bar", "height") === "var(--h-title)",
  String(declValue(css, ".title-bar", "height")));
check("tab strip is 35px", declValue(css, ".tab-strip", "height") === "var(--h-tab)",
  String(declValue(css, ".tab-strip", "height")));

group("the Cmd+K island matches the specification");
// 580px wide, 64px minimum, translucent with a cyan-tinted border.
check("island is 580px wide", declValue(css, ".cmdk", "width") === "580px",
  String(declValue(css, ".cmdk", "width")));
check("island is at least 64px tall", declValue(css, ".cmdk", "min-height") === "64px",
  String(declValue(css, ".cmdk", "min-height")));
// The minifier rewrites rgba(26,26,30,.82) as #1a1a1ed1, so translucency is
// checked in both spellings rather than against one of them.
const islandBg = String(declValue(css, ".cmdk", "background") || "");
const translucent =
  /rgba\(/.test(islandBg)
  || (/^#[0-9a-f]{8}$/.test(islandBg) && Number.parseInt(islandBg.slice(7), 16) < 255);
check("island is translucent (the glass in the spec)", translucent, islandBg);
check("island has a backdrop blur", /blur/.test(String(declValue(css, ".cmdk", "backdrop-filter") || "")),
  String(declValue(css, ".cmdk", "backdrop-filter")));
check("island border is tinted toward the accent",
  /56,\s*189,\s*248/.test(String(declValue(css, ".cmdk", "border"))),
  String(declValue(css, ".cmdk", "border")));

group("the model menu matches the screenshot");
// A 260px popup, 26x14 switches, hairline rules between the three groups.
check("menu is 260px wide", declValue(css, ".mm", "width") === "260px",
  String(declValue(css, ".mm", "width")));
check("switch is 26x14", declValue(css, ".mm-switch", "width") === "26px"
  && declValue(css, ".mm-switch", "height") === "14px",
  `${declValue(css, ".mm-switch", "width")}x${declValue(css, ".mm-switch", "height")}`);
check("group rules are hairlines", declValue(css, ".mm-rule", "height") === "1px",
  String(declValue(css, ".mm-rule", "height")));

group("diff colours are the ones the screenshots show");
check("removed blocks use the measured red", tokens["--diff-del-bg"] === "#511c22",
  String(tokens["--diff-del-bg"]));
check("added blocks use the measured green", tokens["--diff-add-bg"] === "#1f431f",
  String(tokens["--diff-add-bg"]));

group("the panels are resizable, as the reference requires");
check("there is a resize handle", /panel-resizer/.test(css));
// The rule that was previously dead: nothing ever applied this class, so
// dragging the edge selected the text it swept over.
check("dragging suppresses text selection",
  /is-resizing/.test(css) && /user-select:\s*none/.test(css),
  "is-resizing + user-select:none");

group("low-memory mode still drops what costs memory");
// The project is built for 2 GB, so the escape hatches are load-bearing rather
// than decoration: an animation that ignores them costs real memory.
const hasLowMemRule = (rule) =>
  css.includes(`html[data-low-memory="on"] ${rule}`)
  || css.includes(`html[data-low-memory=on] ${rule}`);
for (const rule of [".cmdk-spinner", ".cmdk", ".ai-composer-wrap.is-agent"]) {
  check(`${rule} is suppressed under low memory`, hasLowMemRule(rule));
}
check("backdrop blur is dropped under low memory",
  hasLowMemRule(".cmdk") && /backdrop-filter:\s*none/.test(css));

group("no dead selectors");
const tsSrc = allFiles(join(ROOT, "src"), ".ts")
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
// The word boundary must be an escaped backslash-b in the source. Written as a
// single backslash it becomes the backspace character inside the template
// literal, which matches nothing and makes every class look dead.
const wordBoundary = "\\b";
const orphans = [...classNamesIn(css)].filter(
  (c) => !new RegExp(`${wordBoundary}${c}${wordBoundary}`).test(tsSrc),
);
check("no orphaned class selectors in the stylesheet", orphans.length === 0,
  orphans.slice(0, 8).join(", ") || "none");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
