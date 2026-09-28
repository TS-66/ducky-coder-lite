/**
 * Inline AI editing.
 *
 * The interaction users expect: select some code, say what you want, see a diff,
 * accept or reject. The rule that matters is that **nothing is ever written
 * without an explicit click** — the model produces text, the diff shows it, and
 * the file only changes when the user presses Accept.
 *
 * The selection is what gets sent, plus a small amount of surrounding context so
 * the model understands where the code lives. Never the whole file unless the
 * selection is most of it.
 */

import { h } from "../core/dom";
import { icons } from "./icons";
import { store, toast, openFile } from "../core/store";
import { api } from "../core/backend";
import { openDiff } from "./diff";
import { confirmCommand } from "./ai-panel";
import { createTerminal } from "./terminal";

/** What the editor currently needs from us. Set by `main.ts`. */
let host: {
  getSelection(): string;
  getContent(): string;
  getPath(): string;
  getLanguage(): string;
  getCursor(): { line: number; column: number };
  replaceAll(content: string): void;
  getRange(): { from: number; to: number } | null;
} | null = null;

export function setEditorHost(h: NonNullable<typeof host>): void {
  host = h;
}

let pending = false;
let promptEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;

const QUICK_PROMPTS: { label: string; text: string }[] = [
  { label: "Make this faster", text: "Make this faster. Keep the same behaviour and the same public interface." },
  { label: "Add error handling", text: "Add error handling to this. Report failures clearly rather than panicking or returning garbage." },
  { label: "Explain", text: "Explain what this does, in a few sentences." },
  { label: "Refactor", text: "Refactor this for clarity. Do not change what it does." },
  { label: "Add doc comments", text: "Add concise doc comments explaining what this does and what it expects." },
  { label: "Write tests", text: "Write unit tests for this." },
];

/** Open the inline AI prompt anchored to the current selection. */
export function openInlineAi(anchor?: { x: number; y: number }): void {
  if (!host) return;
  if (pending) return;

  closeInlineAi();

  const selection = host.getSelection();
  const hasSelection = selection.trim().length > 0;

  inputEl = h("input", {
    class: "inline-ai-input",
    type: "text",
    placeholder: hasSelection ? "Ask Ducky AI to change the selected code…" : "Ask Ducky AI…",
    spellcheck: false,
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit(inputEl!.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeInlineAi();
        hostRef.focus();
      }
    },
  }) as HTMLInputElement;

  promptEl = h(
    "div",
    { class: "inline-ai" },
    h(
      "div",
      { class: "inline-ai-head" },
      icons.duck(14),
      h("span", { class: "inline-ai-title" }, "Ducky AI"),
      hasSelection
        ? h("span", { class: "inline-ai-scope" }, `${selection.split("\n").length} line${selection.split("\n").length === 1 ? "" : "s"} selected`)
        : h("span", { class: "inline-ai-scope" }, "current file"),
      h(
        "button",
        { class: "icon-btn", title: "Close", onClick: () => closeInlineAi() },
        icons.close(12),
      ),
    ),
    inputEl,
    h(
      "div",
      { class: "inline-ai-quick" },
      ...QUICK_PROMPTS.map((q) =>
        h(
          "button",
          {
            class: "inline-ai-chip",
            onClick: () => {
              inputEl!.value = q.text;
              void submit(q.text);
            },
          },
          q.label,
        ),
      ),
    ),
  );

  const pos = anchor ?? cursorViewportPosition();
  document.body.appendChild(promptEl);

  // Position near the cursor, clamped to the viewport.
  const rect = promptEl.getBoundingClientRect();
  promptEl.style.left = `${Math.max(8, Math.min(pos.x, window.innerWidth - rect.width - 8))}px`;
  promptEl.style.top = `${Math.max(8, Math.min(pos.y, window.innerHeight - rect.height - 8))}px`;

  inputEl.focus();
}

function cursorViewportPosition(): { x: number; y: number } {
  if (!host) return { x: 80, y: 80 };
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width || rect.height || rect.top) {
      return { x: rect.left, y: rect.bottom + 6 };
    }
  }
  // No selection: drop it below the tab strip.
  return { x: 120, y: 90 };
}

function closeInlineAi(): void {
  promptEl?.remove();
  promptEl = null;
  inputEl = null;
}

let hostRef: { focus(): void } = { focus: () => {} };
export function setFocusTarget(target: { focus(): void }): void {
  hostRef = target;
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

async function submit(instruction: string): Promise<void> {
  if (!host || !instruction.trim()) return;
  if (pending) return;

  const selection = host.getSelection();
  const path = host.getPath();
  const language = host.getLanguage();
  const whole = host.getContent();
  const cursor = host.getCursor();

  // The model needs to know where the selection sits in the file. A little
  // leading context makes the difference between a correct edit and a plausible
  // one that does not compile.
  const lines = whole.split("\n");
  const fromLine = Math.max(0, cursor.line - 12);
  const context = lines.slice(fromLine, cursor.line - 1).join("\n");

  const userText = context
    ? `${instruction}\n\nCode immediately before the selection:\n${context}\n\nSelected code:\n${selection || "(cursor only)"}`
    : `${instruction}\n\nCurrent file (${path}):\n${trimForPrompt(whole)}`;

  pending = true;
  setBusy(true);

  try {
    const result = await api.aiCompleteTask(
      `inline-${Date.now()}`,
      userText,
      selection,
      path,
      false,
    );

    const cleaned = stripFences(result);
    if (!cleaned.trim()) {
      toast("Ducky AI had nothing to suggest.", "info");
      return;
    }

    // Work out what to apply. If the reply is a whole file, replace; if it is a
    // block, offer both readings and default to the one that matches the shape
    // of the request.
    const looksLikeWholeFile = looksCompleteFile(cleaned, language);
    const after = looksLikeWholeFile ? cleaned : applyToWholeFile(whole, selection, cleaned);

    if (after === whole) {
      toast("Ducky AI's suggestion was identical to the current code.", "info");
      return;
    }

    openDiff({
      path,
      before: whole,
      after,
      mode: "next",
      title: `${instruction.slice(0, 60)}${instruction.length > 60 ? "…" : ""}`,
      onAccept: (newContent) => {
        host!.replaceAll(newContent);
        const tab = store.state.tabs.find((t) => t.path === path);
        if (tab) {
          store.update((s) => {
            const t = s.tabs.find((x) => x.path === path);
            if (t) t.dirty = true;
          });
        }
        toast("Applied. It is an unsaved change — press Ctrl+S to keep it.", "success");
        hostRef.focus();
      },
      onReject: () => {
        hostRef.focus();
      },
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  } finally {
    pending = false;
    setBusy(false);
    closeInlineAi();
    hostRef.focus();
  }
}

function setBusy(busy: boolean): void {
  promptEl?.classList.toggle("is-busy", busy);
  if (inputEl) inputEl.disabled = busy;
}

function stripFences(text: string): string {
  const fenced = /^```[\w]*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return fenced ? fenced[1]! : text;
}

function trimForPrompt(text: string): string {
  const limit = 12_000;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated) …`;
}

/** Heuristic: does the reply look like a complete file rather than a fragment? */
function looksCompleteFile(text: string, language: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes("...") && trimmed.split("\n").length < 3) return false;
  const lastLine = trimmed.split("\n").pop()?.trim() ?? "";
  switch (language) {
    case "python": return lastLine === "" || lastLine.startsWith("def ") || lastLine.startsWith("class ") || trimmed.startsWith("import ") || trimmed.startsWith("from ");
    case "rust": return lastLine === "}" || lastLine === "};" || trimmed.startsWith("use ") || trimmed.startsWith("#[");
    case "javascript":
    case "typescript": return lastLine === "}" || lastLine === ";" || lastLine === "})" || trimmed.startsWith("import ") || trimmed.startsWith("export ");
    case "lua": return lastLine === "end";
    case "go": return lastLine === "}";
    case "java": return lastLine === "}";
    case "shell": return true;
    default: return false;
  }
}

/**
 * Splice a fragment into the file.
 *
 * If the fragment begins with the same text as the selection, it is a full
 * replacement of that block; otherwise it is appended after it. This is the
 * behaviour that makes an AI edit usable rather than a coin flip.
 */
function applyToWholeFile(whole: string, selection: string, fragment: string): string {
  if (!selection) {
    // No selection: insert at the cursor.
    return whole + fragment;
  }
  const idx = whole.indexOf(selection);
  if (idx < 0) return whole + fragment;

  const fragTrimmed = fragment.trim();
  const selTrimmed = selection.trim();
  if (fragTrimmed.startsWith(selTrimmed.slice(0, Math.min(40, selTrimmed.length)))) {
    // The model echoed the selection and continued it: replace in place.
    return whole.slice(0, idx) + fragment + whole.slice(idx + selection.length);
  }
  if (fragTrimmed.includes(selTrimmed.slice(0, Math.min(40, selTrimmed.length)))) {
    return whole.slice(0, idx) + fragment + whole.slice(idx + selection.length);
  }
  return whole.slice(0, idx) + selection + "\n" + fragment + whole.slice(idx + selection.length);
}

// ---------------------------------------------------------------------------
// Quick AI actions from the command palette / selection menu
// ---------------------------------------------------------------------------

export type QuickAction =
  | "explain"
  | "fix"
  | "refactor"
  | "tests"
  | "docs"
  | "optimize"
  | "command"
  | "agent";

const ACTION_INSTRUCTIONS: Record<QuickAction, string> = {
  explain: "Explain what this code does and why it is written this way. Be concise and concrete.",
  fix: "Find the bug in this code and fix it. Explain the root cause in one or two sentences before the fix.",
  refactor: "Refactor this code so it is clearer, without changing its behaviour. Keep the public interface the same.",
  tests: "Write unit tests for this code. Use the test framework already used in this project if there is one.",
  docs: "Add clear documentation to this code: what it does, its inputs, its outputs and any assumptions it makes.",
  optimize: "Make this code faster or lighter on memory, while keeping its behaviour identical. Explain the trade-off.",
  command: "What single shell command should I run to achieve this? Answer with the command only, in a bash code block, and say what it does in one line.",
  agent: "",
};

export async function runQuickAction(action: QuickAction): Promise<void> {
  if (!host) return;

  if (action === "command") {
    await suggestCommand();
    return;
  }

  const instruction = ACTION_INSTRUCTIONS[action];
  await submit(`${instruction}\n\nTarget file: ${host.getPath()}`);
}

async function suggestCommand(): Promise<void> {
  if (!host) return;
  const selection = host.getSelection();
  const question = window.prompt(
    "What do you want Ducky AI to help you run?",
    selection ? selection.slice(0, 120) : "Install the dependencies",
  );
  if (!question) return;

  const result = await api.aiCompleteTask(
    `cmd-${Date.now()}`,
    `${ACTION_INSTRUCTIONS.command}\n\nI want to: ${question}`,
    selection,
    host.getPath(),
    true,
  );

  // Take the first line of the first bash block as the proposed command.
  const block = /```(?:bash|sh|shell)?\n?([\s\S]*?)```/.exec(result);
  const command = (block ? block[1]! : result).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))[0];

  if (!command) {
    toast("Ducky AI did not suggest a command.", "info");
    return;
  }

  const approved = await confirmCommand(command);
  if (!approved) {
    toast("Command not run.", "info");
    return;
  }

  store.update((s) => {
    s.bottomPanel = "terminal";
  });
  if (store.state.activeTerminalId === null) await createTerminal();
  const id = store.state.activeTerminalId;
  if (id === null) return;
  await api.terminalWrite(id, `${command}\r`);
  toast("Running in the terminal.", "success");
}

export { openFile, h };
