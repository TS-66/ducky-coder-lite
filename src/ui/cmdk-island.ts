/**
 * The Cmd+K editing island.
 *
 * A floating panel over the editor canvas for describing a change in prose and
 * having it applied to the current selection. It differs from the `mod+i` inline
 * AI in three deliberate ways:
 *
 *   * it is *big* -- an instruction that rewrites a function is a paragraph, not
 *     a phrase, and a one-line input makes people write worse instructions;
 *   * it is *translucent* -- you keep reading the code underneath while you
 *     describe the change, because the point is to change code you can see;
 *   * it is *reviewable* -- the reply is never written straight to the buffer.
 *     It comes back as a diff, so an edit is always something you accept.
 *
 * The "don't ask again" control is per-session on purpose. Persisting a global
 * "stop asking me" across projects would silently disable the one safety net
 * that stands between a confused instruction and a corrupted file.
 */

import { h, fill } from "../core/dom";
import { toast } from "../core/store";
import { api } from "../core/backend";
import { icons } from "./icons";
import { editorHost, focusEditor } from "./inline-ai";
import { openDiff } from "./diff";
import { IS_MAC } from "../core/dom";

let islandOpen = false;
let island: HTMLElement | null = null;
let busy = false;
let suppressAsk = false;
let seq = 0;

/** Strip a markdown fence, which models add even when told not to. */
function stripFences(text: string): string {
  return text
    .replace(/^```[\w-]*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trimEnd();
}

export function isCmdKOpen(): boolean {
  return islandOpen;
}

export function closeCmdK(): void {
  island?.remove();
  island = null;
  islandOpen = false;
}

/** The model capsule's shortcut helper, reused so the keycaps match. */
const acceptKey = IS_MAC ? "⌘⏎" : "Ctrl+⏎";
const rejectKey = IS_MAC ? "Esc" : "Esc";

export function openCmdKIsland(): void {
  if (island) {
    // Already open: treat the shortcut as "take me back to the prompt" rather
    // than stacking a second island.
    island.querySelector<HTMLTextAreaElement>(".cmdk-textarea")?.focus();
    return;
  }

  // The same host the inline AI uses, so the selection and the path are the ones
  // the editor actually has right now.
  const host = editorHost();
  if (!host) {
    toast("Open a file first.", "info");
    return;
  }

  const selection = host.getSelection();
  const path = host.getPath();

  const textarea = h("textarea", {
    class: "cmdk-textarea",
    rows: 2,
    placeholder: selection
      ? "Describe the change to the selected code…"
      : "Describe the change to make here…",
    spellcheck: false,
  }) as HTMLTextAreaElement;

  const status = h("div", { class: "cmdk-status" });
  const acceptBtn = h(
    "button",
    { class: "cmdk-btn cmdk-btn--accept" },
    icons.check(12),
    h("span", null, "Accept"),
    h("span", { class: "cmdk-key" }, acceptKey),
  );
  const rejectBtn = h(
    "button",
    { class: "cmdk-btn" },
    icons.close(12),
    h("span", null, "Reject"),
    h("span", { class: "cmdk-key" }, rejectKey),
  );
  const askToggle = h(
    "label",
    { class: "cmdk-ask", title: "Stop offering this shortcut for the rest of the session" },
    h("input", { class: "cmdk-ask-box", type: "checkbox" }),
    h("span", null, "Don't ask again for such edits"),
  );

  const closeBtn = h(
    "button",
    { class: "cmdk-close", title: `Close (${rejectKey})`, "aria-label": "Close" },
    icons.close(12),
  );

  island = h(
    "div",
    { class: "cmdk", role: "dialog", "aria-label": "Edit with Ducky AI" },
    closeBtn,
    h("div", { class: "cmdk-grip" }),
    textarea,
    h(
      "div",
      { class: "cmdk-foot" },
      acceptBtn,
      rejectBtn,
      h("span", { class: "cmdk-foot-spacer" }),
      askToggle,
    ),
    status,
  );

  // Over the editor canvas, not over the window: the code being changed has to
  // stay visible while the instruction is written.
  const mount = document.querySelector(".editor-area") ?? document.body;
  mount.appendChild(island);
  islandOpen = true;

  textarea.focus();

  const dismiss = (): void => {
    closeCmdK();
    // Focus goes back to the editor, or the next keystroke lands nowhere.
    focusEditor();
  };

  closeBtn.addEventListener("click", dismiss);
  rejectBtn.addEventListener("click", dismiss);

  island.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });

  askToggle.querySelector("input")?.addEventListener("change", (e) => {
    suppressAsk = (e.target as HTMLInputElement).checked;
    if (suppressAsk) toast("Inline edit prompts are off for this session.", "info");
  });

  // Clicking the canvas behind dismisses, the way every floating surface in the
  // app behaves.
  const onAway = (e: MouseEvent): void => {
    if (island && !island.contains(e.target as Node)) dismiss();
  };
  window.setTimeout(() => document.addEventListener("mousedown", onAway, true), 0);

  const submit = async (): Promise<void> => {
    if (busy) return;
    const instruction = textarea.value.trim();
    if (!instruction) {
      textarea.focus();
      return;
    }
    busy = true;
    island?.classList.add("is-busy");
    fill(status, h("span", { class: "cmdk-spinner" }), h("span", null, "Working…"));

    try {
      const id = `cmdk-${Date.now()}-${++seq}`;
      const result = await api.aiCompleteTask(id, instruction, selection, path, false);
      const cleaned = stripFences(result);
      if (!cleaned.trim()) {
        fill(status, h("span", null, "Ducky AI had nothing to suggest."));
        return;
      }
      fill(status, h("span", null, "Review the change below."));
      // Never written straight to the buffer: the diff is the review step.
      openDiff({ path, before: selection, after: cleaned, isNew: false });
      closeCmdK();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fill(status, h("span", { class: "cmdk-error" }, message));
      toast(message, "error");
    } finally {
      busy = false;
      island?.classList.remove("is-busy");
    }
  };

  acceptBtn.addEventListener("click", () => void submit());
}

/**
 * The `mod+k` entry point.
 *
 * Always reports handled, so the shortcut is never also interpreted as an
 * editor command. If the user has switched the prompt off, the keystroke is
 * still consumed: silently letting `Cmd+K` do something else would be worse
 * than doing nothing.
 */
export function cmdKFromShortcut(): boolean {
  if (island) {
    island.querySelector<HTMLTextAreaElement>(".cmdk-textarea")?.focus();
    return true;
  }
  if (suppressAsk) return true;
  openCmdKIsland();
  return true;
}
