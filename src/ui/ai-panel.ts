/**
 * The Ducky AI panel: chat, agent mode, context control, and change review.
 *
 * ## Three things this panel does that matter
 *
 * 1. **It shows its work.** Before anything is sent, the context inspector
 *    states exactly which files and how many tokens are in the request. That is
 *    a privacy control, not decoration: the user is deciding what leaves the
 *    machine, and they can do it per file.
 * 2. **It never writes silently.** A reply containing a proposed change renders
 *    as a diff with Accept / Reject / Accept All / Reject All. There is no path
 *    from model output to the filesystem that does not pass through a click.
 * 3. **It cannot be a memory leak.** The transcript is capped, older turns are
 *    evicted, and "Clear Chat" drops the strings on the spot rather than
 *    waiting for a garbage collection that may never come.
 */

import { h, fill, clear, escapeHtml, debounce, formatTokens } from "../core/dom";
import { icons } from "./icons";
import { store, toast, LIMITS, type ChatEntry, type Proposal, type State } from "../core/store";
import { api, on } from "../core/backend";
import { openDiff } from "./diff";
import { createTerminal } from "./terminal";

let transcript: HTMLElement | null = null;
let composer: HTMLTextAreaElement | null = null;
let contextBar: HTMLElement | null = null;
let built = false;
let contextTimer: number | undefined;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function renderAiPanel(host: HTMLElement, s: State): void {
  if (!built) {
    build(host);
    built = true;
  }

  renderStatus(s);
  renderContextBar(s);
  renderTranscript();
  syncComposer(s);
}

function build(host: HTMLElement): void {
  contextBar = h("div", { class: "ai-context-bar" });

  transcript = h("div", { class: "ai-transcript" });

  composer = h("textarea", {
    class: "ai-composer",
    rows: 3,
    placeholder: "Ask Ducky AI about your code…",
    spellcheck: false,
    onInput: () => {
      autoGrow(composer!);
      scheduleContextPreview();
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
  }) as HTMLTextAreaElement;

  host.appendChild(
    h(
      "div",
      { class: "ai-wrap" },
      h(
        "div",
        { class: "ai-toolbar" },
        h(
          "div",
          { class: "ai-seg", role: "tablist", "aria-label": "Ducky AI mode" },
          ...(["chat", "composer"] as const).map((mode) =>
            h(
              "button",
              {
                class: "ai-seg-btn",
                role: "tab",
                title:
                  mode === "chat"
                    ? "Chat: ask questions about your code"
                    : "Composer: make changes across several files",
                onClick: () => {
                  // Composer is a view, not a capability -- it is the same
                  // conversation with the proposal surface open. Chat is the
                  // default because it is what most turns actually are.
                  store.update((st) => {
                    st.composerMode = mode === "composer";
                  });
                  renderModeToggle();
                },
              },
              mode === "chat" ? "Chat" : "Composer",
            ),
          ),
        ),
        h(
          "div",
          { class: "ai-toolbar-actions" },
          h(
            "button",
            {
              class: "icon-btn",
              title: "New conversation",
              onClick: () => newConversation(),
            },
            icons.plus(13),
          ),
          h(
            "button",
            {
              class: "icon-btn",
              title: "Clear chat and release its memory",
              onClick: () => clearChat(),
            },
            icons.trash(13),
          ),
        ),
      ),
      contextBar,
      transcript,
      h(
        "div",
        { class: "ai-composer-wrap" },
        composer,
        h(
          "div",
          { class: "ai-composer-actions" },
          // Agent lives here rather than in the header: it changes what the
          // model is *allowed to do*, which is a property of the request being
          // composed, not of which view you are looking at.
          h(
            "button",
            {
              class: "ai-agent",
              title: "Agent mode. Ducky AI may propose file changes and commands; every one still needs your approval.",
              onClick: () => {
                store.update((st) => {
                  st.agentMode = !st.agentMode;
                });
                renderModeToggle();
              },
            },
            h("span", { class: "ai-agent-track" }, h("span", { class: "ai-agent-knob" })),
            h("span", { class: "ai-agent-label" }, "Agent"),
          ),
          h("span", { class: "ai-actions-spacer" }),
          h(
            "span",
            { class: "ai-hint" },
            "Enter to send · Shift+Enter for a new line",
          ),
          h(
            "button",
            {
              class: "ai-send",
              title: "Send (Enter)",
              onClick: () => void send(),
            },
            icons.send(14),
          ),
        ),
      ),
      h(
        "div",
        { class: "ai-suggestions" },
        ...[
          "Explain this file",
          "Fix the error I'm looking at",
          "Refactor this function",
          "Write tests for this",
        ].map((t) =>
          h(
            "button",
            {
              class: "ai-suggestion",
              onClick: () => {
                if (composer) composer.value = t;
                void send();
              },
            },
            t,
          ),
        ),
      ),
    ),
  );

  renderModeToggle();
  window.addEventListener("resize", autoGrowNow);
}

function autoGrowNow(): void {
  if (composer) autoGrow(composer);
}

function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(220, el.scrollHeight)}px`;
}

/**
 * Reflect agent mode and the Chat/Composer selection in the DOM.
 *
 * Agent mode is a class on the *composer*, not a class on a control: the whole
 * input capsule changes appearance, because the thing the user needs to notice
 * is not the switch but the box the model will answer into.
 */
function renderModeToggle(): void {
  const wrap = document.querySelector(".ai-composer-wrap");
  wrap?.classList.toggle("is-agent", store.state.agentMode);

  const agent = document.querySelector(".ai-agent");
  agent?.classList.toggle("is-on", store.state.agentMode);

  const composer = document.querySelector(".ai-seg-btn:nth-child(2)");
  const chat = document.querySelector(".ai-seg-btn:nth-child(1)");
  const inComposer = store.state.composerMode;
  composer?.setAttribute("aria-selected", String(inComposer));
  chat?.setAttribute("aria-selected", String(!inComposer));
  composer?.classList.toggle("is-active", inComposer);
  chat?.classList.toggle("is-active", !inComposer);
}

// ---------------------------------------------------------------------------
// Status + context
// ---------------------------------------------------------------------------

function renderStatus(s: State): void {
  const el = document.getElementById("ai-status");
  if (!el) return;

  if (s.chatStreaming) {
    el.textContent = "thinking…";
    el.className = "ai-status is-busy";
  } else if (s.aiConnected === true) {
    el.textContent = s.settings?.ai.provider.model ?? "ready";
    el.className = "ai-status is-ok";
  } else if (s.aiConnected === false) {
    el.textContent = "offline";
    el.className = "ai-status is-off";
  } else if (s.settings?.ai.provider.hasKey) {
    el.textContent = "ready";
    el.className = "ai-status is-ok";
  } else {
    el.textContent = "not set up";
    el.className = "ai-status is-unset";
  }
}

/**
 * The context indicator.
 *
 * Shows the file count and the token count of what *would* be sent, and opens
 * an inspector listing each file. Recomputed on a debounce as the user types,
 * and capped: a repository-wide retrieval is limited to `maxContextFiles`.
 */
function scheduleContextPreview(): void {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = window.setTimeout(() => void updateContextPreview(), 420);
}

async function updateContextPreview(): Promise<void> {
  const draft = composer?.value.trim() ?? "";
  const pinned = store.state.pinnedContext;
  if (!draft && pinned.length === 0) {
    store.update((s) => {
      s.lastRetrievedContext = null;
    });
    return;
  }
  try {
    const ctx = await api.aiRetrieveContext(draft || "current file", [], pinned);
    // Ignore a response that arrived after the user typed more.
    if ((composer?.value.trim() ?? "") !== draft) return;
    store.update((s) => {
      s.lastRetrievedContext = ctx;
    });
  } catch {
    // A failed preview is not worth a message; the send path will report it.
  }
}

function renderContextBar(s: State): void {
  if (!contextBar) return;
  const ctx = s.lastRetrievedContext;
  const pinned = s.pinnedContext;

  fill(
    contextBar,
    h(
      "button",
      {
        class: `ai-context-chip${pinned.length ? " is-pinned" : ""}`,
        title: "Click to see exactly which files are sent to the AI provider",
        onClick: () => showContextInspector(s),
      },
      icons.eye(12),
      h("span", null, "Context"),
      ctx
        ? h(
            "span",
            { class: "ai-context-stats" },
            `${ctx.files.length} file${ctx.files.length === 1 ? "" : "s"}`,
            h("span", { class: "ai-context-tokens" }, `${formatTokens(ctx.totalTokens)} tokens`),
            ctx.truncated ? h("span", { class: "ai-context-trunc", title: "The token budget was reached, so the context is partial" }, "partial") : null,
          )
        : null,
      pinned.length ? h("span", { class: "ai-context-pinned" }, `${pinned.length} pinned`) : null,
    ),
  );
}

function showContextInspector(s: State): void {
  const ctx = s.lastRetrievedContext;
  const rows: HTMLElement[] = [];

  if (pinnedList(s).length) {
    rows.push(sectionTitle("PINNED BY YOU"));
    for (const p of pinnedList(s)) {
      rows.push(
        h(
          "div",
          { class: "ctx-row" },
          icons.pin(12),
          h("span", { class: "ctx-path" }, p),
          h(
            "button",
            {
              class: "icon-btn",
              title: "Remove from context",
              onClick: () => {
                store.update((st) => {
                  st.pinnedContext = st.pinnedContext.filter((x) => x !== p);
                });
                void updateContextPreview();
              },
            },
            icons.close(11),
          ),
        ),
      );
    }
  }

  if (ctx && ctx.files.length) {
    rows.push(sectionTitle("RETRIEVED FOR THIS REQUEST"));
    for (const f of ctx.files) {
      rows.push(
        h(
          "div",
          { class: "ctx-row" },
          h("span", { class: "ctx-dot" }),
          h("span", { class: "ctx-path" }, f.path),
          h("span", { class: "ctx-reason" }, f.reason),
          h("span", { class: "ctx-tokens" }, formatTokens(f.tokens)),
        ),
      );
    }
  }

  if (rows.length === 0) {
    rows.push(
      h("div", { class: "ctx-empty" }, "Nothing is being sent yet. Type a question, or pin a file."),
    );
  }

  showModal(
    "AI Context",
    h(
      "div",
      { class: "ctx-panel" },
      h(
        "p",
        { class: "ctx-explain" },
        "These are the only files Ducky Coder Lite will send to the AI provider. It never uploads your workspace automatically — it retrieves only what matches your request, and the amount is capped by the context budget in Settings.",
      ),
      ...rows,
      h(
        "div",
        { class: "modal-actions" },
        ctx
          ? h(
              "button",
              {
                class: "btn",
                onClick: () => {
                  for (const f of ctx.files) {
                    if (!s.pinnedContext.includes(f.path)) store.state.pinnedContext.push(f.path);
                  }
                  store.notify();
                  toast(`Pinned ${ctx.files.length} files to the context.`, "success");
                },
              },
              h("span", null, "Pin all of these"),
            )
          : null,
        h(
          "button",
          {
            class: "btn",
            onClick: () => {
              store.update((st) => {
                st.pinnedContext = [];
                st.lastRetrievedContext = null;
              });
            },
          },
          h("span", null, "Clear Context"),
        ),
        h(
          "button",
          {
            class: "btn",
            onClick: () => {
              window.dispatchEvent(new CustomEvent("ducky:open-settings", { detail: "ai" }));
            },
          },
          h("span", null, "Context settings"),
        ),
      ),
    ),
  );
}

function pinnedList(s: State): string[] {
  return s.pinnedContext;
}

function sectionTitle(text: string): HTMLElement {
  return h("div", { class: "ctx-section" }, text);
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function renderTranscript(): void {
  if (!transcript) return;
  const s = store.state;

  // An empty conversation shows what the assistant can do, which doubles as
  // the answer to "what does Agent mode actually do here".
  if (s.chat.length === 0) {
    if (transcript.dataset.mode !== "empty") {
      transcript.dataset.mode = "empty";
      fill(transcript, emptyState());
    }
    return;
  }

  transcript.dataset.mode = "live";
  fill(
    transcript,
    ...s.chat.map((entry) => renderEntry(entry)),
  );
  transcript.scrollTop = transcript.scrollHeight;
}

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "ai-empty" },
    h("div", { class: "ai-empty-mark" }, icons.duck(34)),
    h("div", { class: "ai-empty-title" }, "Ducky AI"),
    h(
      "div",
      { class: "ai-empty-text" },
      "Ask about your code, or switch to Agent mode to have Ducky AI propose changes and commands.",
    ),
    h(
      "ul",
      { class: "ai-empty-list" },
      h("li", null, "Only the files that match your question are sent"),
      h("li", null, "Every edit is shown as a diff before it is written"),
      h("li", null, "Every command is shown before it runs"),
      h("li", null, "Inference runs remotely, so this machine stays light"),
    ),
  );
}

function renderEntry(entry: ChatEntry): HTMLElement {
  if (entry.role === "user") {
    return h(
      "div",
      { class: "ai-msg ai-msg--user" },
      h(
        "div",
        { class: "ai-bubble" },
        ...renderMarkdownish(entry.text),
      ),
    );
  }

  if (entry.role === "system") {
    return h("div", { class: "ai-msg ai-msg--system" }, entry.text);
  }

  return h(
    "div",
    { class: "ai-msg ai-msg--assistant" },
    h(
      "div",
      { class: "ai-bubble" },
      ...renderMarkdownish(entry.text),
      entry.streaming ? h("span", { class: "ai-cursor" }) : null,
      entry.cancelled ? h("div", { class: "ai-note" }, "Stopped.") : null,
    ),
    // What `mod+l` sent, shown as a chip so the reference is visible and can be
    // seen to be the right code.
    entry.selection
      ? h(
          "div",
          { class: "ai-sel-chip", title: entry.selection.path },
          icons.file(11),
          h("span", { class: "ai-sel-path" }, entry.selection.path.split("/").pop() ?? entry.selection.path),
          h(
            "span",
            { class: "ai-sel-meta" },
            `${entry.selection.text.split("\n").length} line${entry.selection.text.split("\n").length === 1 ? "" : "s"} selected`,
          ),
        )
      : null,
    entry.context
      ? h(
          "div",
          { class: "ai-ctx-used" },
          icons.eye(11),
          h(
            "span",
            null,
            `${entry.context.files.length} file${entry.context.files.length === 1 ? "" : "s"} · ${formatTokens(entry.context.totalTokens)} tokens sent`,
          ),
        )
      : null,
    entry.proposal ? renderProposal(entry.proposal) : null,
  );
}

/** A deliberately small markdown subset: paragraphs, fenced code, inline code,
 *  bold, italics and bullet lists. A full markdown engine would be tens of
 *  kilobytes and a sanitiser to go with it; this covers what AI replies use. */
function renderMarkdownish(text: string): (HTMLElement | string)[] {
  const out: (HTMLElement | string)[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        h(
          "div",
          { class: "ai-code" },
          lang ? h("div", { class: "ai-code-lang" }, lang) : null,
          h("pre", null, h("code", null, body.join("\n"))),
          h(
            "button",
            {
              class: "ai-code-copy",
              title: "Copy",
              onClick: () => void navigator.clipboard.writeText(body.join("\n")),
            },
            icons.copy(11),
          ),
        ),
      );
      continue;
    }

    // Bullet list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push(
        h("ul", { class: "ai-list" }, ...items.map((t) => h("li", null, ...inline(t)))),
      );
      continue;
    }

    // Numbered list.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      out.push(h("ol", { class: "ai-list" }, ...items.map((t) => h("li", null, ...inline(t)))));
      continue;
    }

    // Heading.
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(h("div", { class: "ai-heading", style: `font-size:${15 - heading[1].length}px` }, ...inline(heading[2])));
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: gather until a blank line or a block-level construct.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(h("p", { class: "ai-para" }, ...inline(para.join("\n"))));
  }

  return out;
}

/** Inline spans. Every piece is built as a text node, so model output can never
 *  inject markup into the panel. */
function inline(text: string): (HTMLElement | string)[] {
  const out: (HTMLElement | string)[] = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(__[^_\n]+__)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) out.push(h("code", { class: "ai-inline-code" }, token.slice(1, -1)));
    else if (token.startsWith("**")) out.push(h("strong", null, token.slice(2, -2)));
    else if (token.startsWith("__")) out.push(h("strong", null, token.slice(2, -2)));
    else out.push(h("em", null, token.slice(1, -1)));
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// Proposals: the approval gate
// ---------------------------------------------------------------------------

/** Pull ```path blocks out of a reply, if the model produced any. */
export function extractProposals(text: string, existing: Map<string, string>): Proposal | null {
  const files: Proposal["files"] = [];
  const commands: string[] = [];

  const pathBlocks = /```path\s+([^\n`]+)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = pathBlocks.exec(text)) !== null) {
    const path = m[1].trim();
    const content = m[2];
    files.push({
      path,
      content,
      create: !existing.has(path),
      original: existing.get(path),
    });
  }

  // Shell commands the model suggests, in a `bash`/`sh` block.
  const shellBlocks = /```(?:bash|sh|shell|console)\n([\s\S]*?)```/g;
  while ((m = shellBlocks.exec(text)) !== null) {
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) commands.push(t);
    }
  }

  if (files.length === 0 && commands.length === 0) return null;
  return {
    id: `p${Date.now()}`,
    files,
    summary: files.length
      ? `${files.length} file${files.length === 1 ? "" : "s"} changed`
      : `${commands.length} command${commands.length === 1 ? "" : "s"} suggested`,
    commands,
  };
}

function renderProposal(proposal: Proposal): HTMLElement {
  const container = h("div", { class: "ai-proposal" });

  const render = (): void => {
    const rows: HTMLElement[] = [];

    for (const file of proposal.files) {
      rows.push(
        h(
          "div",
          { class: "proposal-file" },
          h(
            "button",
            {
              class: "proposal-file-name",
              title: "Show the full diff before applying",
              onClick: () => {
                openDiff({
                  path: file.path,
                  before: file.original ?? "",
                  after: file.content,
                  isNew: file.create,
                });
              },
            },
            file.create ? icons.plus(11) : icons.edit(11),
            h("span", null, file.path),
            h("span", { class: "proposal-badge" }, file.create ? "new" : "modified"),
          ),
        ),
      );
    }

    for (const cmd of proposal.commands) {
      rows.push(
        h(
          "div",
          { class: "proposal-command" },
          h("span", { class: "proposal-caret" }, "$"),
          h("code", null, cmd),
        ),
      );
    }

    fill(
      container,
      h(
        "div",
        { class: "proposal-head" },
        icons.sparkle(12),
        h("span", { class: "proposal-summary" }, proposal.summary),
        h(
          "span",
          { class: "proposal-warning" },
          store.state.settings?.ai.agentRequiresApproval
            ? "Nothing is written until you accept"
            : "Review before accepting",
        ),
      ),
      ...rows,
      h(
        "div",
        { class: "proposal-actions" },
        h(
          "button",
          { class: "btn btn--primary", onClick: () => void acceptAll(proposal) },
          icons.check(12),
          h("span", null, "Accept All"),
        ),
        h(
          "button",
          { class: "btn", onClick: () => void rejectAll(proposal) },
          icons.close(12),
          h("span", null, "Reject All"),
        ),
        proposal.files.length
          ? h(
              "button",
              {
                class: "btn",
                title: "Review the full diff",
                onClick: () => {
                  const f = proposal.files[0];
                  openDiff({
                    path: f.path,
                    before: f.original ?? "",
                    after: f.content,
                    isNew: f.create,
                  });
                },
              },
              h("span", null, "Review Diff"),
            )
          : null,
      ),
    );
  };

  render();
  return container;
}

async function acceptAll(proposal: Proposal): Promise<void> {
  if (proposal.files.length === 0) {
    // Commands only: ask for approval one at a time, in the terminal.
    for (const cmd of proposal.commands) {
      const ok = await confirmCommand(cmd);
      if (!ok) continue;
      await runApprovedCommand(cmd);
    }
    return;
  }

  const approved = await confirmLargeWrite(proposal);
  if (!approved) return;

  try {
    const applied = await api.applyEdits(
      proposal.files.map((f) => ({ path: f.path, content: f.content, create: f.create })),
      true,
    );
    // Reflect the new content in the open tab, if there is one.
    for (const a of applied) {
      const tab = store.state.tabs.find((t) => t.path === a.path);
      if (tab && tab.content !== undefined) {
        tab.content = proposal.files.find((f) => f.path === a.path)?.content ?? tab.content;
        tab.dirty = true;
      }
    }
    store.update((s) => {
      const entry = s.chat.find((c) => c.proposal?.id === proposal.id);
      if (entry) entry.proposal = undefined;
    });
    toast(`Applied ${applied.length} file change${applied.length === 1 ? "" : "s"}.`, "success");
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function rejectAll(proposal: Proposal): Promise<void> {
  store.update((s) => {
    const entry = s.chat.find((c) => c.proposal?.id === proposal.id);
    if (entry) entry.proposal = undefined;
  });
  toast("Rejected. Nothing was changed.");
}

function confirmLargeWrite(proposal: Proposal): Promise<boolean> {
  return new Promise((resolve) => {
    const list = proposal.files
      .map((f) => h("li", null, f.path, " ", h("em", null, f.create ? "(new file)" : "")))
      .slice(0, 12);
    showModal(
      "Apply these changes?",
      h(
        "div",
        null,
        h(
          "p",
          { class: "modal-text" },
          "Ducky AI wants to write the following files. They will be opened in your editor as unsaved changes, so you can review and undo them.",
        ),
        h("ul", { class: "modal-list" }, ...list),
        proposal.files.length > 12
          ? h("p", { class: "modal-note" }, `…and ${proposal.files.length - 12} more.`)
          : null,
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "btn", onClick: () => { closeModal(); resolve(false); } }, h("span", null, "Cancel")),
          h("button", { class: "btn btn--primary", onClick: () => { closeModal(); resolve(true); } }, h("span", null, "Apply")),
        ),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Command approval
// ---------------------------------------------------------------------------

/**
 * Ask before running a command. Destructive and mutating commands get a
 * stronger prompt, and the risk classification is shown so the user is deciding
 * with the relevant information in front of them.
 */
export async function confirmCommand(command: string): Promise<boolean> {
  let risk = "readOnly";
  try {
    risk = (await api.classifyCommand(command)).risk;
  } catch {
    // If we cannot classify it, treat it as the dangerous case.
    risk = "mutating";
  }
  return confirmRisky(command, risk);
}

function confirmRisky(command: string, risk: string): Promise<boolean> {
  return new Promise((resolve) => {
    const strong = risk === "destructive" || risk === "mutating";
    showModal(
      strong ? "Run this command?" : "Run this command?",
      h(
        "div",
        null,
        strong
          ? h(
              "div",
              { class: "modal-warning" },
              icons.warning(14),
              h(
                "span",
                null,
                risk === "destructive"
                  ? "This looks destructive. Read it before you run it."
                  : "This command changes something on your system.",
              ),
            )
          : null,
        h("pre", { class: "modal-code" }, command),
        h(
          "p",
          { class: "modal-note" },
          risk === "readOnly"
            ? "This appears to be read-only."
            : "Ducky AI cannot undo a command. You can edit it before running.",
        ),
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "btn", onClick: () => { closeModal(); resolve(false); } }, h("span", null, "Cancel")),
          h(
            "button",
            { class: "btn btn--primary", onClick: () => { closeModal(); resolve(true); } },
            h("span", null, "Run"),
          ),
        ),
      ),
    );
  });
}

async function runApprovedCommand(command: string): Promise<void> {
  store.update((s) => {
    s.bottomPanel = "terminal";
  });
  const existing = store.state.activeTerminalId;
  if (existing === null) await createTerminal();
  else {
    store.update((s) => {
      s.bottomPanel = "terminal";
    });
  }
  const id = store.state.activeTerminalId;
  if (id === null) return;
  await api.terminalWrite(id, `${command}\r`);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

let requestCounter = 0;

// ---------------------------------------------------------------------------
// Live streaming
// ---------------------------------------------------------------------------
//
// The backend pushes tokens as `ai://delta` events. Rendering each one
// separately would re-render the whole panel per token, which on a 2 GB machine
// is the difference between "feels instant" and "the window stutters". So
// deltas accumulate in a buffer and are flushed once per animation frame: any
// number of tokens arriving in the same frame costs exactly one render.

let streamEntryId: string | null = null;
let streamBuffer = "";
let streamFrame = 0;

function flushStream(): void {
  streamFrame = 0;
  const id = streamEntryId;
  if (!id || !streamBuffer) return;
  const addition = streamBuffer;
  streamBuffer = "";
  store.update((s) => {
    const entry = s.chat.find((c) => c.id === id);
    if (entry) entry.text += addition;
  });
}

function scheduleFlush(): void {
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(flushStream);
}

function endStream(): void {
  if (streamFrame) cancelAnimationFrame(streamFrame);
  streamFrame = 0;
  streamBuffer = "";
  streamEntryId = null;
}

/** Subscribe once. Safe to call again; each call replaces the listeners. */
export async function installStreamListeners(): Promise<void> {
  await on<{ text: string }>("ai://delta", (evt) => {
    if (!streamEntryId) return;
    streamBuffer += evt.text ?? "";
    scheduleFlush();
  });

  await on<{ finishReason: string | null; cancelled: boolean }>("ai://done", (e) => {
    // Flush whatever is still buffered before the caller replaces the text with
    // the authoritative copy, so the tail of the reply is never dropped.
    flushStream();
    if (e?.cancelled && streamEntryId) {
      const id = streamEntryId;
      store.update((s) => {
        const entry = s.chat.find((c) => c.id === id);
        if (entry) entry.cancelled = true;
      });
    }
  });

  await on<{ message: string }>("ai://error", () => {
    flushStream();
    const id = streamEntryId;
    if (!id) return;
    store.update((s) => {
      const entry = s.chat.find((c) => c.id === id);
      if (entry) entry.error = true;
    });
    // The awaited promise also rejects, and its handler sets the text, so this
    // listener only has to stop the streaming state.
  });
}

async function send(): Promise<void> {
  if (!composer) return;
  const text = composer.value.trim();
  if (!text) return;
  if (store.state.chatStreaming) {
    toast("Ducky AI is still working on the previous message.", "info");
    return;
  }

  const s = store.state;
  const activeTab = s.tabs.find((t) => t.id === s.activeTabId);
  const s2 = store.state;

  // Clear the composer first: the message is committed, and a stuck composer
  // would invite a double send.
  store.update((st) => {
    st.chatDraft = "";
  });
  composer.value = "";

  const pinned = [...s2.pinnedContext];
  if (activeTab && activeTab.content !== undefined && !pinned.includes(activeTab.path)) {
    // The file you are looking at is the most relevant thing there is.
    pinned.push(activeTab.path);
  }

  const userEntry: ChatEntry = {
    id: `u${Date.now()}`,
    role: "user",
    text,
    ts: Date.now(),
  };
  const assistantEntry: ChatEntry = {
    id: `a${Date.now()}`,
    role: "assistant",
    text: "",
    streaming: true,
    ts: Date.now(),
  };

  store.update((st) => {
    st.chat.push(userEntry, assistantEntry);
    st.chatHistory.push({ role: "user", content: text });
    st.chatStreaming = true;
    // Apply the transcript cap in the same transaction, so the array never
    // exceeds its bound even for a moment.
    if (st.chat.length > LIMITS.chatEntries) {
      st.chat = st.chat.slice(st.chat.length - LIMITS.chatEntries);
    }
  });

  const requestId = `chat-${++requestCounter}`;
  // Bind the streaming slot to this bubble. Only one request can be in flight
  // (`chatStreaming` is checked above), so a single slot is the whole state.
  endStream();
  streamEntryId = assistantEntry.id;

  // Retrieve the context up front so the user can see it on the bubble.
  try {
    const ctx = await api.aiRetrieveContext(text, [], pinned);
    const target = store.state.chat.find((c) => c.id === assistantEntry.id);
    if (target) {
      target.context = { files: ctx.files, totalTokens: ctx.totalTokens, truncated: ctx.truncated };
    }
    store.notify();
  } catch {
    // Not fatal: the request still runs, just without the context badge.
  }

  try {
    const result = await api.aiChat(
      requestId,
      store.state.chatHistory.slice(-LIMITS.chatEntries),
      text,
      pinned,
      store.state.agentMode,
    );
    // The reply has already been painted token by token; `result` is the
    // authoritative copy, so it replaces what was streamed rather than adding
    // to it.
    endStream();
    finishAssistant(assistantEntry.id, result, text);
  } catch (err) {
    endStream();
    const cancelled = (err as { cancelled?: boolean }).cancelled;
    store.update((st) => {
      const entry = st.chat.find((c) => c.id === assistantEntry.id);
      if (entry) {
        entry.streaming = false;
        if (cancelled) {
          entry.cancelled = true;
          entry.text = entry.text || "(stopped)";
        } else {
          entry.error = true;
          entry.text = err instanceof Error ? err.message : String(err);
        }
      }
      st.chatStreaming = false;
    });
  }
}

/** Finish a streamed reply: store it, then look for changes it proposed. */
function finishAssistant(entryId: string, text: string, userPrompt: string): void {
  const existing = new Map<string, string>();
  for (const tab of store.state.tabs) {
    if (tab.content !== undefined) existing.set(tab.path, tab.content);
  }

  const proposal = store.state.agentMode ? extractProposals(text, existing) : null;

  store.update((s) => {
    const entry = s.chat.find((c) => c.id === entryId);
    if (!entry) return;
    entry.text = text;
    entry.streaming = false;
    entry.proposal = proposal ?? undefined;
    s.chatStreaming = false;
    if (text) s.chatHistory.push({ role: "assistant", content: text });
    // Bound the assistant history that gets resent each turn.
    if (s.chatHistory.length > LIMITS.chatEntries) {
      s.chatHistory.splice(0, s.chatHistory.length - LIMITS.chatEntries);
    }
  });

  void userPrompt;
}

export function stopStreaming(): void {
  void api.aiCancelAll().catch(() => {});
  store.update((s) => {
    s.chatStreaming = false;
    for (const c of s.chat) if (c.streaming) c.streaming = false;
  });
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function newConversation(): void {
  store.update((s) => {
    s.chat = [];
    s.chatHistory = [];
    s.pinnedContext = [];
    s.lastRetrievedContext = null;
  });
  store.releaseMemory(false);
  toast("Started a new conversation.", "success");
}

export function clearChat(): void {
  // Drop every string immediately. `store.releaseMemory` then trims the rest.
  store.update((s) => {
    s.chat = [];
    s.chatHistory = [];
    s.lastRetrievedContext = null;
  });
  store.releaseMemory(true);
  if (composer) composer.value = "";
  toast("Chat cleared and its memory released.", "success");
}

function syncComposer(s: State): void {
  if (composer && composer.value !== s.chatDraft) {
    composer.value = s.chatDraft;
    autoGrow(composer);
  }
  const sendBtn = document.querySelector(".ai-send");
  sendBtn?.classList.toggle("is-busy", s.chatStreaming);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function showModal(title: string, body: HTMLElement): void {
  closeModal();
  const overlay = h(
    "div",
    { class: "modal-overlay", onClick: (e: MouseEvent) => { if (e.target === overlay) closeModal(); } },
    h(
      "div",
      { class: "modal", role: "dialog", "aria-modal": "true" },
      h(
        "div",
        { class: "modal-head" },
        h("h2", { class: "modal-title" }, title),
        h("button", { class: "icon-btn", title: "Close", onClick: () => closeModal() }, icons.close(13)),
      ),
      h("div", { class: "modal-body" }, body),
    ),
  );
  document.body.appendChild(overlay);
}

export function closeModal(): void {
  document.querySelector(".modal-overlay")?.remove();
}

export { escapeHtml, debounce, clear };
