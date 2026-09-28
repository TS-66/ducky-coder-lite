/**
 * The title bar.
 *
 * A 44px band across the top of the window that carries four things, in a fixed
 * order so the muscle memory holds:
 *
 *   left    window history chevrons, then the workspace name
 *   centre  the breadcrumb path of the active file
 *   right   indexing status, the model capsule, the connection dot, the account
 *
 * The centre group is absolutely centred rather than laid out with flex, so the
 * path stays visually centred no matter how wide the right-hand cluster grows.
 * That is deliberate: a breadcrumb that drifts left as the model name changes
 * length reads as unstable.
 *
 * Everything here is decoration over real state. The model capsule reports the
 * configured model, the dot reports whether the app is online, and the indexing
 * line reports the real search state. Nothing is hard-coded to look plausible.
 */

import { h, fill } from "../core/dom";
import { icons } from "./icons";
import type { State } from "../core/store";

export interface TitleBar {
  el: HTMLElement;
  render: (state: State) => void;
}

export function createTitleBar(opts: {
  onBack: () => void;
  onForward: () => void;
  onOpenModelPicker: () => void;
  onOpenCommandCenter: () => void;
  onOpenAccount: () => void;
  onOpenIndexingInfo: () => void;
}): TitleBar {
  // --- left: history + workspace ------------------------------------------

  const history = h(
    "div",
    { class: "title-history" },
    h(
      "button",
      { class: "title-nav", title: "Back", "aria-label": "Back", onClick: () => opts.onBack() },
      icons.chevronLeft(16),
    ),
    h(
      "button",
      { class: "title-nav", title: "Forward", "aria-label": "Forward", onClick: () => opts.onForward() },
      icons.chevronRight(16),
    ),
  );


  // --- centre: the command pill -------------------------------------------

  // A bordered, rounded, centred field showing the workspace name. It is the
  // window's single "where am I" control and the entry point to the command
  // palette, which is why it is a pill with a border rather than plain text.
  const pill = h(
    "button",
    {
      class: "title-pill",
      title: "Search files and commands",
      onClick: () => opts.onOpenCommandCenter(),
    },
    h("span", { class: "title-pill-icon" }, icons.search(12)),
    h("span", { class: "title-pill-text" }, "crypto-price-converter"),
  );

  // --- right: status cluster -----------------------------------------------

  const indexStatus = h("button", {
    class: "title-index",
    title: "Indexing status",
    onClick: () => opts.onOpenIndexingInfo(),
  });

  const modelNode = h("span", { class: "title-model-name" }, "Ducky");
  const modelCapsule = h(
    "button",
    {
      class: "title-model",
      title: "AI model",
      onClick: () => opts.onOpenModelPicker(),
    },
    modelNode,
    h("span", { class: "title-model-chevron" }, icons.chevronDown(12)),
  );

  // A 6px dot, per the spec. It is a plain element rather than an icon so it
  // stays exactly 6px at any zoom.
  const cloudDot = h("span", { class: "title-cloud", title: "Connection" });

  const account = h(
    "button",
    { class: "title-account", title: "Account", onClick: () => opts.onOpenAccount() },
    h("span", { class: "title-avatar" }, "D"),
  );

  const pillNode = h("span", { class: "title-pill-text" }, "Ducky Coder Lite");
  pill.replaceChild(pillNode, pill.querySelector(".title-pill-text")!);

  const el = h(
    "header",
    { class: "title-bar", role: "banner" },
    h("div", { class: "title-left" }, history),
    h("div", { class: "title-centre" }, pill),
    h("div", { class: "title-right" }, indexStatus, modelCapsule, cloudDot, account),
  );

  // --- render --------------------------------------------------------------

  const render = (state: State): void => {
    const wsName = state.workspace?.name || "";

    // The pill names the workspace, and only the workspace. The file path has
    // its own row under the tabs, which is where a path belongs: it changes far
    // more often than the window does.
    const pillText = wsName || "Ducky Coder Lite";
    if (pillNode.textContent !== pillText) pillNode.textContent = pillText;

    // Indexing. The label reports the real search state rather than animating
    // forever -- a spinner that always spins is a lie about a 2 GB machine.
    const running = state.search.running;
    const scanned = state.search.filesScanned;
    const note = running
      ? `Indexing codebase… ${scanned} files`
      : state.search.query && state.search.matches.length
        ? `${state.search.matches.length} results`
        : "";
    indexStatus.style.display = note ? "" : "none";
    indexStatus.classList.toggle("is-active", running);
    fill(
      indexStatus,
      running ? h("span", { class: "title-spinner" }) : null,
      h("span", { class: "title-index-text" }, note),
    );

    // Model capsule.
    const provider = state.settings?.ai.provider;
    const modelName = provider?.model || "No model";
    if (modelNode.textContent !== modelName) modelNode.textContent = modelName;
    modelCapsule.classList.toggle("is-unset", !provider?.hasKey);

    // Connection. Green only when a key is actually configured *and* the last
    // check succeeded; "looks connected" is worse than an honest grey dot.
    const online = !!provider?.hasKey && state.aiConnected !== false;
    cloudDot.classList.toggle("is-online", online);
    cloudDot.classList.toggle("is-offline", !online);
  };

  return { el, render };
}
