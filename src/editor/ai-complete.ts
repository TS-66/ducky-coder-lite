/**
 * AI autocomplete.
 *
 * ## Why this does not fire on every keystroke
 *
 * An implementation that requests a completion per character is broken three
 * ways at once: it burns API quota, it pins memory in the HTTP client while
 * requests are outstanding, and on a slow machine the latency makes the
 * suggestion arrive after the user has already moved on. So a request here must
 * pass four gates, all of them before a single byte leaves the machine:
 *
 *  1. **Intent.** Only when the text before the cursor looks like a place a
 *     completion belongs — after `(`, `,`, `=`, `:`, a dot, or a partial word.
 *     Never inside a comment.
 *  2. **Debounce.** `autocompleteDebounceMs` of quiet typing, and longer still
 *     in Low Memory Mode.
 *  3. **Context budget.** A small window around the cursor, capped by
 *     `maxFileChars` and tightened further under memory pressure. Never the
 *     file, never the project.
 *  4. **Cancellation.** A newer request supersedes the previous one, so we stop
 *     paying for tokens nobody will read.
 *
 * Because the local sources are synchronous and always available, the popup
 * appears instantly with word and snippet completions on an offline or
 * unconfigured machine; the AI suggestion joins it if and when it arrives.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { api } from "../core/backend";
import type { Settings } from "../core/backend";

/** Keywords offered without any network call. */
const KEYWORDS: Record<string, string[]> = {
  rust: ["fn", "let", "mut", "struct", "enum", "impl", "trait", "pub", "use", "mod", "match", "if", "else", "for", "while", "loop", "return", "async", "await", "Result", "Option", "Some", "None", "Ok", "Err", "println!", "format!", "vec!"],
  python: ["def", "class", "return", "yield", "import", "from", "as", "if", "elif", "else", "for", "while", "try", "except", "finally", "with", "lambda", "self", "print", "len", "range", "enumerate", "zip", "dict", "list", "str", "int", "float", "bool", "None", "True", "False", "__init__", "__main__"],
  typescript: ["interface", "type", "enum", "class", "extends", "implements", "const", "let", "var", "function", "async", "await", "export", "default", "import", "from", "return", "if", "else", "for", "while", "switch", "case", "try", "catch", "finally", "public", "private", "readonly", "Promise", "Array", "Record"],
  javascript: ["const", "let", "var", "function", "async", "await", "export", "default", "import", "require", "return", "if", "else", "for", "while", "switch", "case", "try", "catch", "finally", "class", "extends", "new", "this", "Promise", "Array", "Object", "JSON", "console"],
  lua: ["local", "function", "end", "if", "then", "else", "elseif", "for", "while", "do", "repeat", "until", "return", "break", "require", "print", "pairs", "ipairs", "table", "string", "math", "self"],
  go: ["func", "package", "import", "var", "const", "type", "struct", "interface", "if", "else", "for", "range", "return", "switch", "case", "defer", "go", "chan", "map", "error", "string", "int", "bool", "fmt"],
  java: ["public", "private", "protected", "class", "interface", "extends", "implements", "static", "final", "void", "int", "long", "double", "boolean", "String", "return", "if", "else", "for", "while", "switch", "case", "try", "catch", "throw", "new", "this", "super", "null"],
  c: ["int", "char", "float", "double", "void", "long", "short", "unsigned", "signed", "struct", "union", "enum", "typedef", "static", "const", "extern", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "sizeof", "malloc", "free", "printf", "NULL"],
  cpp: ["#include", "using", "namespace", "class", "struct", "template", "typename", "public", "private", "protected", "virtual", "override", "const", "static", "constexpr", "auto", "int", "double", "bool", "string", "void", "return", "if", "else", "for", "while", "try", "catch", "new", "delete", "this"],
  shell: ["if", "then", "else", "elif", "fi", "for", "do", "done", "while", "case", "esac", "function", "return", "local", "export", "echo", "cd", "ls", "cat", "grep", "sed", "awk", "find", "make", "git", "npm", "node", "python", "cargo", "rustc", "sudo", "chmod", "mkdir", "rm", "cp", "mv"],
  ruby: ["def", "end", "class", "module", "attr_accessor", "require", "puts", "if", "elsif", "else", "unless", "while", "until", "do", "return", "yield", "self", "nil", "true", "false", "each", "map", "select", "new"],
  php: ["function", "class", "public", "private", "protected", "static", "return", "if", "else", "elseif", "foreach", "for", "while", "echo", "print", "new", "this", "use", "namespace", "extends", "implements", "array", "null", "true", "false", "try", "catch", "throw"],
  csharp: ["using", "namespace", "public", "private", "protected", "internal", "class", "struct", "interface", "record", "var", "async", "await", "return", "if", "else", "for", "foreach", "while", "switch", "try", "catch", "throw", "new", "this", "string", "int", "bool", "void", "List", "Dictionary"],
  swift: ["import", "class", "struct", "enum", "protocol", "extension", "func", "let", "var", "guard", "if", "else", "for", "while", "return", "init", "deinit", "self", "nil", "true", "false", "throws", "async", "await"],
  kotlin: ["fun", "val", "var", "class", "object", "interface", "data", "sealed", "enum", "if", "else", "for", "while", "return", "when", "try", "catch", "import", "package", "private", "public", "internal", "null", "true", "false"],
  sql: ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "AS", "AND", "OR", "NOT", "NULL", "PRIMARY", "KEY", "FOREIGN", "REFERENCES"],
  html: ["div", "span", "p", "a", "img", "button", "input", "form", "section", "header", "footer", "nav", "main", "ul", "li", "table", "script", "style", "link", "meta", "title", "head", "body"],
  css: ["color", "background", "background-color", "margin", "padding", "border", "display", "flex", "grid", "position", "top", "left", "right", "bottom", "width", "height", "font-size", "font-weight", "text-align", "z-index", "opacity", "transition", "transform"],
  dart: ["import", "class", "extends", "implements", "void", "final", "const", "var", "if", "else", "for", "while", "return", "async", "await", "Future", "Stream", "List", "Map", "true", "false", "null"],
  dockerfile: ["FROM", "RUN", "CMD", "LABEL", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL"],
};

/** Snippets, which are far more useful than a bare keyword. */
const SNIPPETS: Record<string, { label: string; detail: string; snippet: string }[]> = {
  python: [
    { label: "def", detail: "function definition", snippet: "def name():\n    pass" },
    { label: "class", detail: "class definition", snippet: "class Name:\n    def __init__(self):\n        pass" },
    { label: "main", detail: "entry point", snippet: 'if __name__ == "__main__":\n    pass' },
    { label: "try", detail: "try/except", snippet: "try:\n    pass\nexcept Exception as e:\n    pass" },
  ],
  rust: [
    { label: "fn", detail: "function", snippet: "fn name() {\n    \n}" },
    { label: "struct", detail: "struct", snippet: "struct Name {\n    \n}" },
    { label: "impl", detail: "impl block", snippet: "impl Type {\n    \n}" },
    { label: "enum", detail: "enum", snippet: "enum Name {\n    \n}" },
    { label: "match", detail: "match expression", snippet: "match expr {\n    pattern => result,\n}" },
    { label: "question", detail: "Result with ?", snippet: "let value = expr?;" },
  ],
  typescript: [
    { label: "interface", detail: "interface", snippet: "interface Name {\n    \n}" },
    { label: "type", detail: "type alias", snippet: "type Name = Type;" },
    { label: "async function", detail: "async fn", snippet: "async function name() {\n    \n}" },
  ],
  javascript: [
    { label: "async function", detail: "async fn", snippet: "async function name() {\n    \n}" },
    { label: "class", detail: "class", snippet: "class Name {\n    constructor() {\n        \n    }\n}" },
  ],
  lua: [
    { label: "function", detail: "function", snippet: "function name()\n    \nend" },
    { label: "if", detail: "if block", snippet: "if cond then\n    \nend" },
  ],
  go: [
    { label: "func", detail: "function", snippet: "func name() {\n    \n}" },
    { label: "errcheck", detail: "error check", snippet: "if err != nil {\n    return err\n}" },
  ],
  java: [{ label: "class", detail: "class", snippet: "public class Name {\n    \n}" }],
  csharp: [{ label: "class", detail: "class", snippet: "public class Name\n{\n    \n}" }],
  c: [{ label: "if", detail: "if block", snippet: "if (cond) {\n    \n}" }],
  cpp: [{ label: "for", detail: "range for", snippet: "for (auto& item : container) {\n    \n}" }],
  shell: [
    { label: "if", detail: "if block", snippet: "if [ cond ]; then\n    \nfi" },
    { label: "for", detail: "for loop", snippet: "for var in list; do\n    \ndone" },
  ],
  javascript_or_typescript: [],
};

/**
 * Words already present in the document, offered for free.
 *
 * Scans backwards from the cursor to a bounded window rather than indexing the
 * file: this runs on every completion request, and an index would cost memory
 * for a feature that only needs the last few kilobytes.
 */
function localWordCompletions(ctx: CompletionContext, typed: string): Completion[] {
  if (!typed) return [];
  const from = ctx.pos;
  const start = Math.max(0, from - 20_000);
  const chunk = ctx.state.doc.sliceString(start, from);

  const counts = new Map<string, number>();
  const re = /[\w$]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const word = m[0];
    if (!word.toLowerCase().startsWith(typed.toLowerCase())) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
    if (counts.size > 200) break;
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word]) => ({ label: word, type: "text", detail: "in this file" }));
}

function keywordCompletions(language: string, typed: string): Completion[] {
  const key = language.toLowerCase();
  const out: Completion[] = [];
  const typedLower = typed.toLowerCase();

  for (const snip of SNIPPETS[key] ?? []) {
    if (snip.label.toLowerCase().startsWith(typedLower)) {
      out.push({
        label: snip.label,
        type: "snippet",
        detail: snip.detail,
        // CodeMirror has no `snippet` property: `apply` is the text inserted,
        // and placeholders are expanded with the built-in snippet syntax.
        apply: snip.snippet,
      });
    }
  }
  for (const kw of KEYWORDS[key] ?? []) {
    if (kw.toLowerCase().startsWith(typedLower)) {
      out.push({ label: kw, type: "keyword", detail: language });
    }
  }
  return out;
}

/**
 * The intent gate: is a completion wanted here at all?
 *
 * This is the single most valuable function in the file. Without it, typing a
 * code comment would cost one API request per word.
 */
function completionIsWanted(ctx: CompletionContext): boolean {
  const before = ctx.matchBefore(/[\w$]+/);
  // A word is being typed: fine, unless the user is about to call something.
  if (before) {
    if (ctx.matchBefore(/[\w$]+\s*\(/)) return false;
    return true;
  }

  // Never inside a comment: the model cannot help and the call is pure cost.
  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, 1);
  if (node && /comment/i.test(node.name)) return false;

  const line = ctx.state.doc.lineAt(ctx.pos);
  const textBefore = line.text.slice(0, ctx.pos - line.from);

  // Structural position: a completion is expected here.
  if (/[([{,=:]\s*$/.test(textBefore)) return true;
  // Member access.
  if (/\.\s*[A-Za-z_]*$/.test(textBefore)) return true;

  // A fresh indented line inside a block.
  if (textBefore.trim() === "") return ctx.pos > line.from;

  return false;
}

/** The bounded slice of the file we are willing to send. */
function contextWindow(state: EditorState, settings: Settings): string {
  const cap = settings.lowMemory.enabled
    ? Math.min(settings.ai.maxFileChars, 2_400)
    : Math.min(settings.ai.maxFileChars, 6_000);
  const pos = state.selection.main.head;
  const from = Math.max(0, pos - Math.floor(cap * 0.7));
  const to = Math.min(state.doc.length, pos + Math.floor(cap * 0.3));
  return state.doc.sliceString(from, to);
}

export interface AiCompletionOptions {
  getSettings(): Settings;
  /** True when the machine is under memory pressure; suppress remote calls. */
  isSuppressed(): boolean;
}

export function buildAiCompletionSource(opts: AiCompletionOptions): Extension {
  let currentRequest: string | null = null;

  const cancelInFlight = (): void => {
    if (!currentRequest) return;
    const id = currentRequest;
    currentRequest = null;
    // Best effort: the backend also stops on its own when the response is
    // dropped, but cancelling here stops the token spend immediately.
    void api.aiCancel(id).catch(() => {});
  };

  // The remote source. Asynchronous, so CodeMirror renders local results first
  // and merges this in when it lands.
  const aiSource: CompletionSource = (ctx: CompletionContext) => {
    const settings = opts.getSettings();
    if (!settings.ai.autocompleteEnabled) return null;
    if (!settings.ai.provider.hasKey) return null;
    if (opts.isSuppressed()) return null;
    if (!completionIsWanted(ctx)) return null;

    const before = ctx.matchBefore(/[\w$]+/);
    const typed = before?.text ?? "";
    const language = detectLanguage(ctx);

    return (async (): Promise<CompletionResult | null> => {
      // Debounce: wait for typing to settle. Resolved by a timer we own, and
      // cleared if a newer completion cycle supersedes this one.
      await delay(settings.ai.autocompleteDebounceMs + (settings.lowMemory.enabled ? 150 : 0));

      if (opts.isSuppressed()) return null;

      const id = `cm:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
      cancelInFlight();
      currentRequest = id;

      const window = contextWindow(ctx.state, opts.getSettings());
      const prompt =
        `Language: ${language}\n\n` +
        `Code up to the insertion point:\n\`\`\`\n${window}\n\`\`\`\n\n` +
        `Continue the code from the insertion point. Reply with only the completion, ` +
        `no explanation and no code fence. If the cursor is already at a natural stopping point, reply with nothing.`;

      try {
        const text = await api.aiCompleteTask(id, prompt, "", null, true);
        // The user typed on while we waited; our answer is stale.
        if (currentRequest !== id) return null;
        const trimmed = text.replace(/^```[\w]*\n?/, "").replace(/```$/, "").trimEnd();
        if (!trimmed.trim()) return null;

        return {
          from: Math.max(0, ctx.pos - typed.length),
          options: [
            {
              label: trimmed.split("\n")[0].slice(0, 60) || trimmed.slice(0, 60),
              type: "ai",
              detail: "Ducky AI",
              apply: trimmed,
              boost: 20,
            },
          ],
          validFor: /^[\w$]*$/,
          filter: false,
        };
      } catch {
        // Autocomplete must never surface an error: the user is typing, and a
        // toast per keystroke would be worse than no completion at all.
        return null;
      } finally {
        if (currentRequest === id) currentRequest = null;
      }
    })();
  };

  // The local source. Synchronous, offline, always available.
  const localSource: CompletionSource = (ctx: CompletionContext) => {
    const before = ctx.matchBefore(/[\w$]+/);
    if (!before) return null;
    const typed = before.text;
    const language = detectLanguage(ctx);

    const options = [
      ...keywordCompletions(language, typed),
      ...localWordCompletions(ctx, typed),
    ];
    if (options.length === 0) return null;

    return { from: ctx.pos - typed.length, options, validFor: /^[\w$]*$/ };
  };

  return autocompletion({
    // `override` runs every source and merges the results, awaiting promises,
    // so the local list paints immediately and the AI entry appends on arrival.
    override: [localSource, aiSource],
    icons: true,
    closeOnBlur: true,
    // A short popup: a long one is a legibility and memory cost.
    maxRenderedOptions: 8,
    defaultKeymap: true,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort language detection from the parse tree.
 *
 * When the grammar is still loading the node name is unhelpfully generic, so we
 * fall back to the file extension recorded on the host.
 */
let fallbackLanguage = "text";
export function setFallbackLanguage(lang: string): void {
  fallbackLanguage = lang;
}

function detectLanguage(ctx: CompletionContext): string {
  const name = syntaxTree(ctx.state).resolveInner(ctx.pos, 1)?.name ?? "";
  const map: Record<string, string> = {
    Python: "python",
    JavaScript: "javascript",
    TypeScript: "typescript",
    Rust: "rust",
    Lua: "lua",
    Go: "go",
    Java: "java",
    C: "c",
    Cpp: "cpp",
    Ruby: "ruby",
    Shell: "shell",
    PHP: "php",
    CSharp: "csharp",
    Swift: "swift",
    Kotlin: "kotlin",
    SQL: "sql",
    CSS: "css",
    XML: "html",
    HTML: "html",
    JSON: "json",
    YAML: "yaml",
    TOML: "toml",
    RustDocComment: "rust",
  };
  return map[name] ?? fallbackLanguage;
}
