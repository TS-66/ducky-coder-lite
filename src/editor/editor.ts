/**
 * The editor: one CodeMirror instance, many documents.
 *
 * ## The single-instance decision
 *
 * A naive tab implementation creates one editor per open tab. Twenty tabs then
 * means twenty CodeMirror states, twenty syntax-highlighters and twenty sets of
 * DOM measurements — which is precisely how an editor ends up using 800 MB and
 * making a 2 GB machine unusable.
 *
 * Instead there is exactly **one** `EditorView` for the whole application. A tab
 * switch swaps the `Text` document and its state into that view. Only the active
 * file is ever parsed, highlighted, measured or rendered, so the editor's memory
 * is a function of the file you are looking at, not of how many files you have
 * opened.
 *
 * ## Virtual rendering
 *
 * CodeMirror only builds DOM for the visible viewport plus a small margin, so a
 * 200,000-line file costs roughly the same as a 200-line one. On top of that
 * `lowMemory` mode caps how many lines may be measured for folding and wrapping,
 * which is the other operation that can scale with file size.
 *
 * ## Language modes are loaded on demand
 *
 * Each language is a separate dynamic `import()`. Opening a Rust file never
 * downloads, parses or keeps the Python, PHP, SQL and shell grammars in memory.
 */

import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  dropCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  indentUnit,
  StreamLanguage,
  LanguageSupport,
  StringStream,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";

import type { Settings } from "../core/backend";
import { compactHighlight } from "./theme";
import { buildAiCompletionSource } from "./ai-complete";
import { duckyDiagnostics } from "./diagnostics";

// ---------------------------------------------------------------------------
// Document swapping
// ---------------------------------------------------------------------------

/** Swap the whole document (and its per-file view state) in and out. */
const swapDoc = StateEffect.define<{ doc: string; language: string; path: string }>();

/** Toggle expensive features at runtime without recreating the view. */
const setCheapMode = StateEffect.define<boolean>();

interface DocMeta {
  language: string;
  path: string;
  scrollTop: number;
  selection: { anchor: number; head: number } | null;
}

/** Per-document state that must survive a tab switch. */
const docMeta = StateField.define<DocMeta>({
  create: () => ({ language: "", path: "", scrollTop: 0, selection: null }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(swapDoc)) {
        next = { language: e.value.language, path: e.value.path, scrollTop: 0, selection: null };
      }
    }
    if (tr.docChanged || tr.selection) {
      const ranges = tr.state.selection.ranges;
      if (ranges.length === 1) {
        next = {
          ...next,
          selection: { anchor: ranges[0].anchor, head: ranges[0].head },
        };
      }
    }
    return next;
  },
});

/** Whether we are in cheap (low memory) rendering mode. */
const cheapMode = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCheapMode)) return e.value;
    return value;
  },
});

// ---------------------------------------------------------------------------
// Language loading (lazy)
// ---------------------------------------------------------------------------

/**
 * `StringStream.match` returns a `RegExpMatchArray` when called without an
 * explicit `consume` flag, and a plain `boolean` otherwise. This narrows to the
 * array form, which is the only one we ever want to index into.
 */
function matched(stream: StringStream, re: RegExp): RegExpMatchArray | null {
  const m = stream.match(re);
  return m && typeof m === "object" ? m : null;
}

/**
 * The shape of a CodeMirror `StreamLanguage` parser.
 *
 * `StreamParser` in `@codemirror/language` is generic over its state type, which
 * makes it awkward to hold in a heterogeneous table of language loaders. This is
 * the subset every mode in `@codemirror/legacy-modes` implements, and it is
 * enough to write the two bespoke modes below. Loaders cast the dynamically
 * imported module to this type.
 */
interface SimpleParser {
  name?: string;
  startState?: () => Record<string, unknown>;
  token(stream: StringStream, state: Record<string, unknown>): string | null;
  tokenTable?: Record<string, RegExp>;
  languageData?: {
    commentTokens?: { line?: string; block?: [string, string] };
  };
}

type StreamParserFactory = () => Promise<unknown>;

/**
 * language id -> loader. Each arrow function is its own chunk, so the grammars
 * for languages you do not open are never fetched.
 */
const LOADERS: Record<string, StreamParserFactory> = {
  rust: async () => (await import("@codemirror/legacy-modes/mode/rust")).rust,
  python: async () => (await import("@codemirror/legacy-modes/mode/python")).python,
  javascript: async () => (await import("@codemirror/legacy-modes/mode/javascript")).javascript,
  typescript: async () => (await import("@codemirror/legacy-modes/mode/javascript")).typescript,
  json: async () => (await import("@codemirror/legacy-modes/mode/javascript")).json,
  json5: async () => (await import("@codemirror/legacy-modes/mode/javascript")).json,
  jsx: async () => (await import("@codemirror/legacy-modes/mode/javascript")).javascript,
  tsx: async () => (await import("@codemirror/legacy-modes/mode/javascript")).typescript,
  go: async () => (await import("@codemirror/legacy-modes/mode/go")).go,
  ruby: async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby,
  shell: async () => (await import("@codemirror/legacy-modes/mode/shell")).shell,
  lua: async () => (await import("@codemirror/legacy-modes/mode/lua")).lua,
  swift: async () => (await import("@codemirror/legacy-modes/mode/swift")).swift,
  java: async () => (await import("@codemirror/legacy-modes/mode/clike")).java,
  c: async () => (await import("@codemirror/legacy-modes/mode/clike")).c,
  cpp: async () => (await import("@codemirror/legacy-modes/mode/clike")).cpp,
  csharp: async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp,
  kotlin: async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin,
  scala: async () => (await import("@codemirror/legacy-modes/mode/clike")).scala,
  dart: async () => (await import("@codemirror/legacy-modes/mode/clike")).dart,
  css: async () => (await import("@codemirror/legacy-modes/mode/css")).css,
  sass: async () => (await import("@codemirror/legacy-modes/mode/css")).sCSS,
  less: async () => (await import("@codemirror/legacy-modes/mode/css")).less,
  html: async () => (await import("@codemirror/legacy-modes/mode/xml")).html,
  xml: async () => (await import("@codemirror/legacy-modes/mode/xml")).xml,
  sql: async () => (await import("@codemirror/legacy-modes/mode/sql")).sql,
  yaml: async () => (await import("@codemirror/legacy-modes/mode/yaml")).yaml,
  toml: async () => (await import("@codemirror/legacy-modes/mode/toml")).toml,
  dockerfile: async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile,
  diff: async () => (await import("@codemirror/legacy-modes/mode/diff")).diff,
  julia: async () => (await import("@codemirror/legacy-modes/mode/julia")).julia,
  r: async () => (await import("@codemirror/legacy-modes/mode/r")).r,
  perl: async () => (await import("@codemirror/legacy-modes/mode/perl")).perl,
  powershell: async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell,
  haskell: async () => (await import("@codemirror/legacy-modes/mode/haskell")).haskell,
  clojure: async () => (await import("@codemirror/legacy-modes/mode/clojure")).clojure,
  erlang: async () => (await import("@codemirror/legacy-modes/mode/erlang")).erlang,
  scheme: async () => (await import("@codemirror/legacy-modes/mode/scheme")).scheme,
  vb: async () => (await import("@codemirror/legacy-modes/mode/vb")).vb,
  batch: async () => (await import("@codemirror/legacy-modes/mode/vbscript")).vbScript,
  // Written here rather than pulled in: these two are common enough to matter
  // and small enough that a bespoke mode is cheaper than a dependency.
  php: () => Promise.resolve(makePhpMode()),
  markdown: () => Promise.resolve(makeMarkdownMode()),
};

/** Cache of already-built LanguageSupport, so re-opening a file is instant. */
const langCache = new Map<string, LanguageSupport | null>();
const inflight = new Map<string, Promise<LanguageSupport | null>>();

async function languageFor(id: string): Promise<LanguageSupport | null> {
  if (langCache.has(id)) return langCache.get(id) ?? null;
  const pending = inflight.get(id);
  if (pending) return pending;

  const loader = LOADERS[id];
  if (!loader) {
    langCache.set(id, null);
    return null;
  }

  const p = (async () => {
    try {
      const parser = (await loader()) as SimpleParser | null | undefined;
      const support =
        parser && typeof parser.token === "function"
          ? new LanguageSupport(
              StreamLanguage.define<Record<string, unknown>>(
                parser as unknown as Parameters<
                  typeof StreamLanguage.define<Record<string, unknown>>
                >[0],
              ),
            )
          : null;
      // Bound the cache: a project touching 40 languages should not keep 40
      // grammars resident forever.
      if (langCache.size > 12) {
        const first = langCache.keys().next().value;
        if (first !== undefined) langCache.delete(first);
      }
      langCache.set(id, support);
      return support;
    } catch {
      langCache.set(id, null);
      return null;
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, p);
  return p;
}

// ---------------------------------------------------------------------------
// Small hand-written modes
// ---------------------------------------------------------------------------

/**
 * A keyword-driven mode factory, used for the two languages that have no legacy
 * mode. Cheap, dependency-free, and enough to make a PHP or Markdown file read
 * correctly instead of as plain text.
 */
function makeKeywordMode(options: {
  keywords: string[];
  types?: string[];
  lineComment?: string;
  blockComment?: [string, string];
  stringDelims?: string[];
}): SimpleParser {
  const keywords = new Set(options.keywords);
  const types = new Set(options.types ?? []);
  const delims = options.stringDelims ?? ["'", '"'];

  interface ModeState extends Record<string, unknown> {
    inBlock: string;
    inString: string | null;
  }

  return {
    name: "keyword",
    startState(): ModeState {
      return { inBlock: "", inString: null };
    },
    token(stream: StringStream, raw: Record<string, unknown>): string | null {
      const state = raw as ModeState;

      if (state.inBlock) {
        if (stream.skipTo(state.inBlock)) {
          stream.match(state.inBlock);
          state.inBlock = "";
        } else {
          stream.skipToEnd();
          return "comment";
        }
      }

      if (state.inString) {
        const quote = state.inString;
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "\\") {
            stream.next();
          } else if (ch === quote) {
            state.inString = null;
            break;
          }
        }
        return "string";
      }

      if (stream.eatSpace()) return null;

      const lineComment = options.lineComment;
      if (lineComment && stream.match(lineComment)) {
        stream.skipToEnd();
        return "comment";
      }

      const [bStart, bEnd] = options.blockComment ?? [];
      if (bStart && stream.match(bStart)) {
        while (!stream.eol()) {
          if (bEnd && stream.match(bEnd)) break;
          stream.next();
        }
        return "comment";
      }

      for (const d of delims) {
        if (stream.match(d)) {
          state.inString = d;
          while (!stream.eol()) {
            const ch = stream.next();
            if (ch === "\\") {
              stream.next();
            } else if (ch === d) {
              state.inString = null;
              break;
            }
          }
          return "string";
        }
      }

      if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";

      const word = matched(stream, /^\w+/);
      if (word) {
        const value = word[0];
        if (keywords.has(value)) return "keyword";
        if (types.has(value)) return "typeName";
        return "variableName";
      }

      stream.next();
      return null;
    },
    languageData: {
      commentTokens: { line: options.lineComment, block: options.blockComment },
    },
  };
}

function makePhpMode(): SimpleParser {
  return makeKeywordMode({
    keywords: [
      "abstract", "and", "array", "as", "break", "callable", "case", "catch", "class",
      "clone", "const", "continue", "declare", "default", "do", "echo", "else",
      "elseif", "empty", "enddeclare", "endfor", "endforeach", "endif", "endswitch",
      "endwhile", "enum", "extends", "final", "finally", "fn", "for", "foreach",
      "function", "global", "goto", "if", "implements", "include", "include_once",
      "instanceof", "insteadof", "interface", "isset", "list", "namespace", "new",
      "or", "print", "private", "protected", "public", "readonly", "require",
      "require_once", "return", "static", "switch", "throw", "trait", "try", "unset",
      "use", "var", "while", "xor", "yield",
    ],
    types: ["int", "float", "string", "bool", "void", "iterable", "object", "mixed", "never"],
    lineComment: "//",
    blockComment: ["/*", "*/"],
  });
}

function makeMarkdownMode(): SimpleParser {
  interface MdState extends Record<string, unknown> {
    inFence: boolean;
    fence: string;
  }

  return {
    name: "markdown",
    startState(): MdState {
      return { inFence: false, fence: "" };
    },
    token(stream: StringStream, raw: Record<string, unknown>): string | null {
      const state = raw as MdState;

      if (state.inFence) {
        if (stream.match(state.fence)) {
          state.inFence = false;
          return "string";
        }
        stream.skipToEnd();
        return "string";
      }

      if (stream.eatSpace()) return null;

      const fence = matched(stream, /^```[a-zA-Z0-9]*/);
      if (fence) {
        state.inFence = true;
        state.fence = fence[0];
        return "string";
      }

      if (stream.match(/^#{1,6}\s/)) return "heading";
      if (stream.match(/^\s*[-*+]\s/)) return "list";
      if (stream.match(/^\s*\d+\.\s/)) return "list";
      if (stream.match(/^\s*>/)) return "comment";
      if (stream.match(/^\s*(?:---+|===+)\s*$/)) return "rule";
      if (stream.match(/^\s*\|/)) return "table";
      if (stream.match(/`[^`\n]+`/)) return "string";
      if (stream.match(/\*\*[^*\n]+\*\*/)) return "strong";
      if (stream.match(/\*[^*\n]+\*/)) return "emphasis";
      if (stream.match(/\[[^\]\n]*\]\([^)\n]*\)/)) return "link";

      stream.next();
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Fold gutter placeholder + current-line highlight
// ---------------------------------------------------------------------------

/** A cheap "current line" decoration that costs nothing when disabled. */
const currentLineHighlight = EditorView.baseTheme({
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.028)" },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(255,255,255,0.028)",
    color: "var(--fg-strong)",
  },
});

// ---------------------------------------------------------------------------
// Editor host
// ---------------------------------------------------------------------------

export interface EditorCallbacks {
  onChange(path: string, content: string): void;
  onCursor(path: string, line: number, column: number): void;
  onSave(path: string): void;
  getSettings(): Settings;
  /** Called when the user presses the inline-AI shortcut. */
  onInlineAI(): void;
}

export class EditorHost {
  view: EditorView;
  private currentPath = "";
  private currentLanguage = "";
  /** Suppress change events while we programmatically swap documents. */
  private swapping = false;
  private settings: Settings | null = null;
  private linting = true;

  constructor(parent: HTMLElement, private cb: EditorCallbacks) {
    this.settings = cb.getSettings();

    const state = EditorState.create({
      doc: "",
      extensions: this.buildExtensions(),
    });

    this.view = new EditorView({ state, parent });

    // A deliberate seam for automated tests. It is one non-enumerable property
    // on the editor's own DOM node -- no global, no behaviour change, nothing
    // reachable from application code -- and it exists because the dirty-state
    // and save path can only be tested by dispatching real CodeMirror
    // transactions. Poking the DOM instead would exercise neither the
    // transaction pipeline nor the change listeners that mark a tab dirty.
    Object.defineProperty(this.view.dom, "cmView", {
      value: this.view,
      configurable: true,
    });
  }

  // -- configuration -------------------------------------------------------

  private buildExtensions(): Extension[] {
    const s = this.settings;
    const lowMem = s?.lowMemory.enabled ?? true;

    const base: Extension[] = [
      // Rendering essentials.
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      // `syntaxHighlighting` with a single, compact style; `highlightStyle`
      // is omitted on purpose so a second, larger theme is not compiled in.
      syntaxHighlighting(compactHighlight, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      docMeta,
      cheapMode,
      currentLineHighlight,
      search({ top: true }),
      // Keymap arrays are registered through `keymap.of` rather than spread
      // into the extension list, so their precedence is explicit and their types
      // line up with the editor's own.
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            this.cb.onSave(this.currentPath);
            return true;
          },
        },
        {
          key: "Mod-Shift-a",
          preventDefault: true,
          run: () => {
            this.cb.onInlineAI();
            return true;
          },
        },
        indentWithTab,
      ]),
      indentUnit.of(" ".repeat(s?.editor.tabSize ?? 4)),
      EditorState.tabSize.of(s?.editor.tabSize ?? 4),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.swapping) {
          const meta = update.state.field(docMeta);
          if (meta.path) this.cb.onChange(meta.path, update.state.doc.toString());
        }
        if (update.selectionSet && !this.swapping) {
          const meta = update.state.field(docMeta);
          if (meta.path) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            this.cb.onCursor(meta.path, line.number, head - line.from + 1);
          }
        }
      }),
    ];

    if (s?.editor.lineNumbers ?? true) {
      base.unshift(lineNumbers());
    }
    if (s?.editor.wordWrap) {
      base.push(EditorView.lineWrapping);
    }
    // Folding is genuinely useful but not free on a huge file, so it is the
    // first thing to go when memory is tight.
    if (!lowMem || (s?.lowMemory.maxRenderLines ?? 12000) > 20000) {
      base.push(foldGutter());
    }
    if (this.linting) {
      base.push(duckyDiagnostics(() => this.currentLanguage));
    }

    if (s?.ai.autocompleteEnabled) {
      base.push(
        buildAiCompletionSource({
          getSettings: () => this.cb.getSettings(),
          // Under memory pressure, remote autocomplete is suppressed entirely.
          isSuppressed: () => this.isCheap(),
        }),
      );
    }

    base.push(themeExtension());
    return base;
  }

  /** Apply changed settings without destroying the view. */
  applySettings(settings: Settings): void {
    const prev = this.settings;
    this.settings = settings;

    const cheap = this.isCheap();
    this.view.dispatch({ effects: setCheapMode.of(cheap) });

    const tabSizeChanged = prev?.editor.tabSize !== settings.editor.tabSize;
    if (tabSizeChanged) {
      // `indentUnit` and `tabSize` are facets, so changing them at runtime means
      // reconfiguring the facet rather than dispatching it as an effect.
      this.view.dispatch({
        effects: StateEffect.reconfigure.of(indentUnit.of(" ".repeat(settings.editor.tabSize))),
      });
      this.view.dispatch({
        effects: StateEffect.reconfigure.of(EditorState.tabSize.of(settings.editor.tabSize)),
      });
    }
    if (prev?.editor.wordWrap !== settings.editor.wordWrap) {
      // `editorAttributes` is a facet, so changing it means reconfiguring that
      // facet rather than dispatching it as an effect.
      this.view.dispatch({
        effects: StateEffect.reconfigure.of(
          EditorView.editorAttributes.of(
            settings.editor.wordWrap ? { style: "white-space: pre-wrap" } : { style: "" },
          ),
        ),
      });
    }
    if (prev?.lowMemory.enabled !== settings.lowMemory.enabled) {
      // Toggling Low Memory Mode changes which extensions are appropriate.
      // Rebuilding the state is a fraction of a second and is the honest thing
      // to do rather than leaving expensive extensions enabled.
      this.rebuild();
    }
  }

  private rebuild(): void {
    const current = this.view.state;
    const meta = current.field(docMeta);
    const state = EditorState.create({
      doc: current.doc,
      selection: current.selection,
      extensions: this.buildExtensions(),
    });
    this.view.setState(state);
    if (meta.path) {
      this.view.dispatch({
        effects: swapDoc.of({ doc: current.doc.toString(), language: meta.language, path: meta.path }),
      });
    }
  }

  private isCheap(): boolean {
    const s = this.settings;
    if (!s) return true;
    return s.lowMemory.enabled && (s.lowMemory.maxRenderLines ?? 12000) < 20000;
  }

  // -- documents -----------------------------------------------------------

  /**
   * Show a file. Passing `undefined` clears the editor.
   *
   * The document swap is a single transaction, so there is no frame in which
   * the editor shows the previous file's content under the new file's language.
   */
  async show(path: string, content: string, language: string, scrollTop = 0): Promise<void> {
    this.currentPath = path;
    this.currentLanguage = language;

    const support = await languageFor(language);
    if (this.currentPath !== path) return; // user moved on while loading

    this.swapping = true;
    try {
      // Build a fresh state carrying the language support. Creating a new
      // EditorState (rather than mutating the old one) is what guarantees the
      // previous document's undo history and parse tree are released.
      const state = EditorState.create({
        doc: content,
        extensions: [...this.buildExtensions(), support ?? []],
      });
      this.view.setState(state);
      this.view.dispatch({ effects: swapDoc.of({ doc: content, language, path }) });
      if (scrollTop > 0) {
        this.view.scrollDOM.scrollTop = scrollTop;
      }
    } finally {
      this.swapping = false;
    }
  }

  clear(): void {
    this.currentPath = "";
    this.swapping = true;
    try {
      this.view.setState(EditorState.create({ doc: "", extensions: this.buildExtensions() }));
    } finally {
      this.swapping = false;
    }
  }

  get path(): string {
    return this.currentPath;
  }

  get content(): string {
    return this.view.state.doc.toString();
  }

  get selection(): string {
    const { from, to } = this.view.state.selection.main;
    if (from === to) return "";
    return this.view.state.doc.sliceString(from, to);
  }

  /** The whole current line, for prompts like "fix this line". */
  currentLine(): string {
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head);
    return line.text;
  }

  focus(): void {
    this.view.focus();
  }

  /** Replace the whole document, used by "Accept All" in the diff view. */
  replaceAll(content: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: content },
    });
  }

  /** Reveal a position (1-based line/column) and put the cursor there. */
  reveal(line: number, column: number, endColumn?: number): void {
    const doc = this.view.state.doc;
    const safeLine = Math.min(Math.max(1, line), doc.lines);
    const l = doc.line(safeLine);
    const anchor = Math.min(l.from + Math.max(0, column - 1), l.to);
    const head = Math.min(l.from + Math.max(0, (endColumn ?? column) - 1), l.to);
    this.view.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    this.view.focus();
  }

  /** Replace a range, for applying an inline-AI edit. */
  replaceRange(from: number, to: number, text: string): void {
    this.view.dispatch({ changes: { from, to, insert: text } });
  }

  goToLine(line: number): void {
    this.reveal(line, 1);
  }

  destroy(): void {
    this.view.destroy();
  }
}

function themeExtension(): Extension {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: "var(--editor-font-size, 13px)",
        backgroundColor: "var(--bg-editor)",
        color: "var(--fg)",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "var(--editor-line-height, 1.55)",
        // The single biggest win for scroll performance on a weak machine:
        // tell the compositor the scroller is the moving part.
        willChange: "transform",
      },
      ".cm-content": {
        padding: "6px 0 40vh 0",
        caretColor: "var(--accent)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--bg-editor)",
        color: "var(--fg-subtle)",
        border: "none",
        borderRight: "1px solid var(--border-subtle)",
        minWidth: "44px",
      },
      ".cm-activeLineGutter": { color: "var(--fg-strong)" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
      ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", opacity: 0.65 },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "rgba(88,166,255,0.22)",
      },
      ".cm-selectionMatch": { backgroundColor: "rgba(232,179,57,0.14)" },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "rgba(232,179,57,0.18)",
        outline: "1px solid rgba(232,179,57,0.45)",
        color: "inherit",
      },
      ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: "rgba(242,96,107,0.2)",
        color: "inherit",
      },
      ".cm-panels": {
        backgroundColor: "var(--bg-panel)",
        color: "var(--fg)",
        border: "none",
        borderTop: "1px solid var(--border)",
      },
      ".cm-panels input, .cm-panels button": {
        backgroundColor: "var(--bg-input)",
        color: "var(--fg)",
        border: "1px solid var(--border-strong)",
        borderRadius: "3px",
        padding: "2px 6px",
        fontFamily: "inherit",
        fontSize: "var(--fs-sm)",
      },
      ".cm-panels button": { cursor: "pointer" },
      ".cm-searchMatch": { backgroundColor: "rgba(232,179,57,0.22)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(232,179,57,0.42)" },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-raised)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius)",
        color: "var(--fg)",
        boxShadow: "var(--shadow-pop)",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--bg-active)",
        color: "var(--fg-strong)",
      },
      ".cm-tooltip.cm-tooltip-lint": { maxWidth: "460px" },
      ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--err)" },
      ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)" },
      ".cm-placeholder": { color: "var(--fg-subtle)" },
    },
    { dark: true },
  );
}

/** Map our CSS custom properties onto the editor's inline style vars. */
export function applyEditorVars(host: HTMLElement, settings: Settings): void {
  host.style.setProperty("--editor-font-size", `${settings.editor.fontSize}px`);
  host.style.setProperty("--editor-line-height", String(settings.editor.lineHeight));
  host.style.setProperty("--font-mono", settings.editor.fontFamily);
}
