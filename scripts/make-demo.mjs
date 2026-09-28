/**
 * Build a standalone demo page from `dist/`, with the mock backend installed
 * before the app bundle runs, so the UI can be screenshotted in a real browser
 * without compiling the Rust backend.
 *
 *   node scripts/make-demo.mjs
 *   # then serve dist/ and open /demo.html
 *
 * This is a development aid. It writes into dist/ and is not part of a release
 * build.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

if (!readdirSync(join(DIST, "assets")).some((f) => /^index-.*\.js$/.test(f))) {
  console.error("no entry chunk in dist/assets — run the frontend build first");
  process.exit(2);
}

// The fixture is shared with the smoke test so the two can never disagree about
// what the app should see. Its ESM syntax is stripped so the body can be
// evaluated as a classic script.
const fixtureSrc = readFileSync(join(ROOT, "scripts", "fixture.mjs"), "utf8");
const fixtureBody = fixtureSrc
  .replace(/^export\s+/gm, "")
  .replace(/^import[^;]*;$/gm, "")
  .trim();

const script = `<script>
/* Development aid: a stub Tauri bridge, installed before the app module runs. */
${fixtureBody}

window.__TAURI__ = {
  core: {
    invoke: (cmd, args) =>
      Promise.resolve(
        Object.prototype.hasOwnProperty.call(HANDLERS, cmd)
          ? HANDLERS[cmd](args || {})
          : null
      ),
  },
  event: { listen: () => Promise.resolve(() => {}) },
};

// Drive the UI so a screenshot shows the whole editor rather than one pane.
// The location hash selects which surfaces to open, e.g. /demo.html#terminal
const want = (name) => location.hash.includes(name);
const click = (sel) => document.querySelector(sel)?.click();
const after = (ms, fn) => setTimeout(fn, ms);
const rowNamed = (name) =>
  [...document.querySelectorAll(".tree-row")]
    .find((r) => r.querySelector(".tree-name")?.textContent === name);

addEventListener("load", () => {
  after(700, () => click(".activity-item--ducky"));

  // Expand tests/ and open a second file so the tab strip shows two tabs.
  after(1200, () => rowNamed("tests")?.querySelector(".tree-twisty")?.click());
  after(1600, () => rowNamed("test_auth.py")?.click());

  if (want("terminal")) {
    after(2100, () => window.dispatchEvent(new CustomEvent("ducky:toggle-terminal")));
  }
  if (want("chat")) {
    after(2700, () => {
      const chip = [...document.querySelectorAll(".ai-suggestion")]
        .find((c) => /Fix the error/.test(c.textContent ?? ""));
      chip?.click();
    });
  }
});
</script>`;

// A still mode, for screenshots. Chromium's `--virtual-time-budget` waits for
// the page to go quiet, and a CSS animation that loops forever means it never
// does -- the screenshot request just hangs until it is killed. The app already
// has a supported way to switch animations off, so the harness uses it rather
// than stripping animations out of the page.
const still = `<script>
  if (location.search.includes("still")) {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.animations = "off";
    });
  }
</script>`;

const html = readFileSync(join(DIST, "index.html"), "utf8");
writeFileSync(
  join(DIST, "demo.html"),
  html.replace("<body>", `<body>\n${still}\n${script}`),
);

console.log(`wrote dist/demo.html`);
console.log("serve dist/ and open /demo.html  (add ?still for screenshots)");
