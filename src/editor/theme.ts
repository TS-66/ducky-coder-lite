/**
 * The syntax highlighting palette.
 *
 * Deliberately restrained: a low-contrast, cool-neutral scheme with one warm
 * accent. Bright rainbow highlighting raises perceived "loudness" and, on an
 * LCD at low brightness, actively costs legibility — the opposite of what a
 * long editing session needs.
 *
 * `HighlightStyle` compiles to a single stylesheet, so a compact tag list is a
 * genuinely smaller document style object at runtime.
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

export const compactHighlight = HighlightStyle.define([
  { tag: t.comment, color: "#5c6673", fontStyle: "italic" },
  { tag: [t.lineComment, t.blockComment], color: "#5c6673", fontStyle: "italic" },
  { tag: t.docComment, color: "#6b7480", fontStyle: "italic" },

  { tag: t.keyword, color: "#d08fe0" },
  { tag: [t.modifier, t.self, t.operatorKeyword], color: "#d08fe0" },
  { tag: [t.controlKeyword, t.moduleKeyword], color: "#d08fe0" },

  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#d5dae3" },
  { tag: [t.function(t.variableName), t.labelName], color: "#7cc4f0" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#e8b339" },
  { tag: [t.definition(t.name), t.separator], color: "#d5dae3" },

  { tag: [t.typeName, t.className, t.namespace], color: "#69d2a0" },
  { tag: [t.number, t.integer, t.float], color: "#e8937a" },
  { tag: [t.bool, t.null, t.atom], color: "#e8937a" },

  { tag: [t.string, t.special(t.string), t.regexp], color: "#a8d98a" },
  { tag: t.escape, color: "#d7c07a" },
  { tag: t.tagName, color: "#7cc4f0" },
  { tag: t.attributeName, color: "#c4b5e8" },
  { tag: t.unit, color: "#8b94a6" },

  { tag: [t.operator, t.punctuation, t.bracket, t.angleBracket], color: "#8b94a6" },
  { tag: t.link, color: "#58a6ff", textDecoration: "underline" },
  { tag: t.heading, color: "#7cc4f0", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.list, color: "#e8b339" },
  { tag: t.meta, color: "#8b94a6" },
  { tag: t.invalid, color: "#ff8f97", textDecoration: "underline" },
]);

/** The editor theme extension, in one place so `main.ts` can apply it once. */
export function editorTheme(): Extension {
  return syntaxHighlighting(compactHighlight, { fallback: true });
}
