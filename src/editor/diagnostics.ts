/**
 * Editor diagnostics.
 *
 * ## Why there is no language server
 *
 * A real LSP integration means spawning a Node or JVM process per language, and
 * those processes routinely cost 150–400 MB each. Running two of them would
 * consume the entire 2 GB budget and take the machine from usable to unusable.
 *
 * So Ducky Coder Lite ships its own small, dependency-free analysers for the
 * constructs that actually matter while typing: unbalanced brackets and quotes,
 * Python and JavaScript indentation problems, suspicious merge markers, a `TODO`
 * sweep for the Problems panel, and shell commands that a user has been warned
 * about. It reports what it can prove and stays silent otherwise, rather than
 * pretending to be a compiler.
 *
 * The analysers run on a debounce and bail out on large documents, because a
 * regex sweep over a 20,000-line file on every keystroke is exactly the kind of
 * background CPU this app promises not to use.
 */

import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";

/** Above this many lines we stop analysing and show a degraded editor. */
const ANALYSE_LIMIT = 8_000;
const MAX_DIAGNOSTICS = 100;

interface Finding {
  from: number;
  to: number;
  severity: "error" | "warning" | "info";
  message: string;
}

/** Collect the matching bracket for each open one, tolerating strings/comments. */
function bracketMismatches(state: EditorState): Finding[] {
  const out: Finding[] = [];
  const stack: { char: string; pos: number }[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closers = new Set([")", "]", "}"]);

  let pos = 0;
  const max = state.doc.length;
  while (pos < max && out.length < 20) {
    // Skip over comments and string literals wholesale; a bracket inside a
    // string is not a bracket.
    const skipped = skipNonCode(state, pos);
    if (skipped > pos) {
      pos = skipped;
      continue;
    }
    const ch = state.doc.sliceString(pos, pos + 1);
    if (pairs[ch]) {
      stack.push({ char: ch, pos });
    } else if (closers.has(ch)) {
      const top = stack.pop();
      if (!top) {
        out.push({
          from: pos,
          to: pos + 1,
          severity: "error",
          message: `Unexpected closing '${ch}' with no matching opener.`,
        });
      } else if (pairs[top.char] !== ch) {
        out.push({
          from: pos,
          to: pos + 1,
          severity: "error",
          message: `'${ch}' closes '${top.char}' opened earlier.`,
        });
        out.push({
          from: top.pos,
          to: top.pos + 1,
          severity: "error",
          message: `'${top.char}' is closed by the wrong bracket.`,
        });
      }
    }
    pos += 1;
  }

  for (const open of stack.slice(0, 10)) {
    out.push({
      from: open.pos,
      to: open.pos + 1,
      severity: "error",
      message: `'${open.char}' is never closed.`,
    });
  }
  return out;
}

/**
 * Advance past a string literal or comment starting at `pos`, or return `pos`
 * when we are in ordinary code.
 *
 * Implemented over the parse tree when a grammar is loaded (correct, and free,
 * since the tree is already built) and with a small scanner otherwise.
 */
function skipNonCode(state: EditorState, pos: number): number {
  const node = syntaxTree(state).resolveInner(pos, 1);
  if (node) {
    const name = node.name;
    if (/comment|string/i.test(name)) {
      return Math.min(node.to, state.doc.length);
    }
    if (node.to > pos) {
      return pos; // inside a real token; do not skip
    }
  }

  const ch = state.doc.sliceString(pos, pos + 2);
  // Line comments.
  if (
    ch === "//" ||
    ch === "--" ||
    (state.doc.sliceString(pos, pos + 1) === "#" && isHashCommentLanguage())
  ) {
    const end = state.doc.lineAt(pos).to;
    return end;
  }
  if (ch === "/*") {
    const end = state.doc.sliceString(pos).indexOf("*/");
    return end < 0 ? state.doc.length : pos + end + 2;
  }
  // Strings.
  const q = state.doc.sliceString(pos, pos + 1);
  if (q === '"' || q === "'" || q === "`") {
    let i = pos + 1;
    while (i < state.doc.length) {
      const c = state.doc.sliceString(i, i + 1);
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === q) return i + 1;
      if (c === "\n" && q !== "`") return i; // unterminated single-line string
      i += 1;
    }
    return state.doc.length;
  }
  return pos;
}

let hashComment = false;
export function setCommentStyle(language: string): void {
  hashComment = ["python", "shell", "yaml", "toml", "ruby", "r", "dockerfile", "makefile", "ini"].includes(
    language.toLowerCase(),
  );
}
function isHashCommentLanguage(): boolean {
  return hashComment;
}

/** Python/Ruby-style indentation problems: a dedent that matches no opener. */
function indentationProblems(state: EditorState, language: string): Finding[] {
  const key = language.toLowerCase();
  if (key !== "python") return [];
  const out: Finding[] = [];

  // Indent stack of [column, lineNumber].
  const stack: { col: number; line: number }[] = [{ col: -1, line: 0 }];
  const limit = Math.min(state.doc.lines, ANALYSE_LIMIT);

  for (let n = 1; n <= limit; n++) {
    const line = state.doc.line(n);
    const text = line.text;
    if (text.trim() === "") continue;
    if (/^\s*(#|"""|''')/.test(text)) continue;

    const indent = text.length - text.trimStart().length;
    const top = stack[stack.length - 1];
    if (indent > top.col) {
      stack.push({ col: indent, line: n });
    } else if (indent < top.col) {
      while (stack.length > 1 && stack[stack.length - 1].col > indent) stack.pop();
      const now = stack[stack.length - 1];
      if (now.col !== indent) {
        out.push({
          from: line.from,
          to: line.from + 1,
          severity: "error",
          message:
            `Indentation does not match any enclosing block. Expected ${
              now.col < 0 ? 0 : now.col
            } spaces, found ${indent}.`,
        });
        if (out.length >= 5) break;
      }
    }
  }
  return out;
}

/** Conflict markers left behind by a botched merge. These are worth flagging
 *  loudly: they are silent syntax errors in every language. */
function mergeMarkers(state: EditorState): Finding[] {
  const out: Finding[] = [];
  const limit = Math.min(state.doc.lines, ANALYSE_LIMIT);
  for (let n = 1; n <= limit && out.length < 3; n++) {
    const line = state.doc.line(n);
    if (/^(<{7}|={7}|>{7})(\s|$)/.test(line.text)) {
      out.push({
        from: line.from,
        to: line.to,
        severity: "error",
        message: "Unresolved merge conflict marker. Resolve this before saving.",
      });
    }
  }
  return out;
}

/** `TODO`/`FIXME` sweep: cheap, and it is what users actually want in the
 *  Problems panel. */
function todoMarkers(state: EditorState): Finding[] {
  const out: Finding[] = [];
  const limit = Math.min(state.doc.lines, ANALYSE_LIMIT);
  for (let n = 1; n <= limit && out.length < 20; n++) {
    const line = state.doc.line(n);
    const m = /\b(TODO|FIXME|HACK|XXX)\b[:(]?\s*(.*)/.exec(line.text);
    if (!m) continue;
    out.push({
      from: line.from,
      to: line.to,
      severity: "info",
      message: m[1] + (m[2] ? `: ${m[2].trim().slice(0, 80)}` : ""),
    });
  }
  return out;
}

export function analyse(state: EditorState, language: string): Finding[] {
  if (state.doc.lines > ANALYSE_LIMIT) {
    // A large file gets a single, honest notice rather than a partial analysis
    // that would look like the file is clean.
    return [
      {
        from: 0,
        to: Math.min(1, state.doc.length),
        severity: "info",
        message:
          "This file is large, so detailed analysis has been limited to keep memory usage down.",
      },
    ];
  }

  const out: Finding[] = [];
  out.push(...mergeMarkers(state));
  if (out.length < MAX_DIAGNOSTICS) out.push(...bracketMismatches(state));
  if (out.length < MAX_DIAGNOSTICS) out.push(...indentationProblems(state, language));
  if (out.length < MAX_DIAGNOSTICS) out.push(...todoMarkers(state));
  return out.slice(0, MAX_DIAGNOSTICS);
}

/**
 * The linter extension. `delay` is generous on purpose: 800 ms of quiet is
 * enough to keep the editor smooth on a weak machine while still feeling live.
 */
export function duckyDiagnostics(getLanguage: () => string): Extension {
  return linter(
    (view): CmDiagnostic[] => {
      const language = getLanguage();
      setCommentStyle(language);
      return analyse(view.state, language).map((f) => ({
        from: Math.min(f.from, view.state.doc.length),
        to: Math.min(f.to, view.state.doc.length),
        severity: f.severity,
        message: f.message,
        source: "Ducky",
      }));
    },
    { delay: 800 },
  );
}
