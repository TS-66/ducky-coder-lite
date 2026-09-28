/**
 * The application shell.
 *
 * Layout, left to right, top to bottom — the arrangement users already know
 * from a modern AI editor:
 *
 * ```
 * ┌──┬──────────┬──────────────────────────┬───────────────┐
 * │  │ sidebar  │  tab strip               │  Ducky AI     │
 * │A │ (one     ├──────────────────────────┤  (optional)   │
 * │c │ panel)   │  editor                  │               │
 * │t │          ├──────────────────────────┴───────────────┤
 * │  │          │  bottom panel: terminal / problems       │
 * ├──┴──────────┴──────────────────────────────────────────┤
 * │ status bar                                              │
 * └──���──────────────────────────────────────────────────────┘
 * ```
 *
 * Every panel is created once and toggled by class and inline sizing, never
 * destroyed and rebuilt. That keeps the DOM stable, which keeps scroll
 * positions, focus and CodeMirror's own viewport cache intact — and it is much
 * cheaper in memory than tearing the tree down.
 */

import { h, fill, clear, button, IS_MAC } from "../core/dom";
import { icons } from "./icons";
import { store, type PanelId, type State } from "../core/store";
import { api } from "../core/backend";

export interface Shell {
  root: HTMLElement;
  activityBar: HTMLElement;
  sidebar: HTMLElement;
  sidebarContent: HTMLElement;
  sidebarPanels: Map<PanelId, HTMLElement>;
  sidebarTitle: HTMLElement;
  editorTabs: HTMLElement;
  editorArea: HTMLElement;
  editorHost: HTMLElement;
  aiPanel: HTMLElement;
  aiContent: HTMLElement;
  bottomPanel: HTMLElement;
  bottomTabs: HTMLElement;
  bottomContent: HTMLElement;
  statusBar: HTMLElement;
  statusLeft: HTMLElement;
  statusRight: HTMLElement;
  welcomeHost: HTMLElement;
  overlay: HTMLElement;
  toastHost: HTMLElement;
  /** Swap panel content. Each view registers here. */
  views: Map<PanelId, (host: HTMLElement, state: State) => void>;
  bottomViews: Map<string, (host: HTMLElement, state: State) => void>;
  focusEditor(): void;
}

const PANELS: { id: PanelId; label: string; icon: () => SVGElement }[] = [
  { id: "explorer", label: "Explorer", icon: icons.explorer },
  { id: "search", label: "Search", icon: icons.search },
  { id: "scm", label: "Source Control", icon: icons.scm },
  { id: "run", label: "Run and Debug", icon: icons.run },
  { id: "extensions", label: "Extensions", icon: icons.extensions },
];

export function createShell(mount: HTMLElement): Shell {
  // --- Activity bar -------------------------------------------------------
  const activityBar = h("nav", { class: "activity-bar", role: "navigation", "aria-label": "Primary" });
  const activityItems = new Map<PanelId, HTMLButtonElement>();
  for (const panel of PANELS) {
    const btn = h(
      "button",
      {
        class: "activity-item",
        title: panel.label,
        "aria-label": panel.label,
        onClick: () => togglePanel(panel.id),
      },
      panel.icon(),
      h("span", { class: "activity-count", id: `count-${panel.id}` }),
    );
    activityItems.set(panel.id, btn);
    activityBar.appendChild(btn);
  }

  // The AI button lives at the bottom of the bar, separated by a rule, because
  // it is the feature rather than a view of the workspace.
  const aiButton = h(
    "button",
    {
      class: "activity-item activity-item--ducky",
      title: `Ducky AI (${IS_MAC ? "⌘⇧A" : "Ctrl+Shift+A"})`,
      "aria-label": "Ducky AI",
      onClick: () => togglePanel("ducky"),
    },
    icons.duck(18),
    h("span", { class: "activity-dot", id: "ducky-dot" }),
  );
  activityBar.appendChild(h("div", { class: "activity-spacer" }));
  activityBar.appendChild(aiButton);
  activityBar.appendChild(
    h(
      "button",
      {
        class: "activity-item",
        title: "Settings",
        "aria-label": "Settings",
        onClick: () => {
          window.dispatchEvent(new CustomEvent("ducky:open-settings"));
        },
      },
      icons.settings(),
    ),
  );

  // --- Sidebar ------------------------------------------------------------
  const sidebarContent = h("div", { class: "sidebar-content" });
  // Each panel gets its own container, created once. Sharing a single container
  // means one panel's render wipes another's DOM, and a "have I mounted yet"
  // flag on the shared host then wrongly suppresses the rebuild -- which left
  // the Explorer blank after Explorer -> Search -> Explorer.
  const sidebarPanels = new Map<PanelId, HTMLElement>();
  for (const id of ["explorer", "search", "scm", "run", "extensions"] as PanelId[]) {
    const el = h("div", { class: "sidebar-panel" });
    el.dataset.panel = id;
    sidebarPanels.set(id, el);
    sidebarContent.appendChild(el);
  }
  const sidebarTitle = h(
    "div",
    { class: "sidebar-title" },
    h("span", { class: "sidebar-title-text" }, "EXPLORER"),
    h("span", { class: "sidebar-title-actions" }),
  );
  const sidebar = h("aside", { class: "sidebar" }, sidebarTitle, sidebarContent);

  // --- Editor -------------------------------------------------------------
  const editorTabs = h("div", { class: "tab-strip", role: "tablist" });
  const editorHost = h("div", { class: "editor-host" });
  const welcomeHost = h("div", { class: "welcome-host" });
  const editorArea = h(
    "main",
    { class: "editor-area" },
    editorTabs,
    h("div", { class: "editor-stack" }, editorHost, welcomeHost),
  );

  // --- AI panel -----------------------------------------------------------
  const aiContent = h("div", { class: "ai-content" });
  const aiPanel = h(
    "aside",
    { class: "ai-panel" },
    h(
      "div",
      { class: "ai-header" },
      icons.duck(15),
      h("span", { class: "ai-header-title" }, "Ducky AI"),
      h("span", { class: "ai-status", id: "ai-status" }, "—"),
      h(
        "button",
        {
          class: "icon-btn",
          title: "Close Ducky AI",
          onClick: () => togglePanel("ducky"),
        },
        icons.close(13),
      ),
    ),
    aiContent,
  );

  // --- Bottom panel -------------------------------------------------------
  const bottomTabs = h("div", { class: "bottom-tabs" });
  const bottomContent = h("div", { class: "bottom-content" });
  const bottomPanel = h("section", { class: "bottom-panel" }, bottomTabs, bottomContent);

  // --- Status bar ---------------------------------------------------------
  const statusLeft = h("div", { class: "status-left" });
  const statusRight = h("div", { class: "status-right" });
  const statusBar = h("footer", { class: "status-bar" }, statusLeft, statusRight);

  // --- Misc ---------------------------------------------------------------
  const overlay = h("div", { class: "overlay-host" });
  const toastHost = h("div", { class: "toast-host", role: "status", "aria-live": "polite" });

  const root = h(
    "div",
    { class: "shell" },
    // The horizontal band. The status bar is a sibling *below* this rather than
    // another column beside it, which is why it needs its own element: in a
    // single row it would sit to the right of the editor instead of beneath it.
    h(
      "div",
      { class: "shell-body" },
      activityBar,
      sidebar,
      h("div", { class: "main-column" }, editorArea, bottomPanel),
      aiPanel,
    ),
    statusBar,
    overlay,
    toastHost,
  );

  mount.appendChild(root);

  const views = new Map<PanelId, (host: HTMLElement, state: State) => void>();
  const bottomViews = new Map<string, (host: HTMLElement, state: State) => void>();

  // Focus trap target: the editor host, when one exists.
  const shell: Shell = {
    root,
    activityBar,
    sidebar,
    sidebarContent,
    sidebarPanels,
    sidebarTitle,
    editorTabs,
    editorArea,
    editorHost,
    aiPanel,
    aiContent,
    bottomPanel,
    bottomTabs,
    bottomContent,
    statusBar,
    statusLeft,
    statusRight,
    welcomeHost,
    overlay,
    toastHost,
    views,
    bottomViews,
    focusEditor: () => {
      const cm = editorHost.querySelector<HTMLElement>(".cm-content");
      if (cm) {
        (cm as HTMLElement & { focus?: () => void }).focus?.();
      }
    },
  };

  function togglePanel(id: PanelId): void {
    store.update((s) => {
      if (id === "ducky") {
        // Opening Ducky AI must not disturb the sidebar: the two are separate
        // surfaces, and a user may well want the file tree and the assistant
        // open side by side.
        s.aiPanelVisible = !s.aiPanelVisible;
        if (s.activePanel === "ducky") s.activePanel = "explorer";
        return;
      }
      if (s.activePanel === id) {
        s.sidebarVisible = !s.sidebarVisible;
      } else {
        s.activePanel = id;
        s.sidebarVisible = true;
      }
    });
  }

  (shell as Shell & { togglePanel: (id: PanelId) => void }).togglePanel = togglePanel;
  return shell;
}

const TITLES: Record<PanelId, string> = {
  explorer: "EXPLORER",
  search: "SEARCH",
  scm: "SOURCE CONTROL",
  run: "RUN",
  extensions: "EXTENSIONS",
  ducky: "DUCKY AI",
};

/** Apply layout and chrome from state. Called on every render. */
export function renderShell(shell: Shell, s: State): void {
  // Activity bar selection.
  for (const [id, btn] of [
    ["explorer", shell.root.querySelector<HTMLButtonElement>(".activity-item")],
  ] as const) {
    void id;
    void btn;
  }
  const items = shell.activityBar.querySelectorAll<HTMLButtonElement>(".activity-item");
  const order: PanelId[] = ["explorer", "search", "scm", "run", "extensions"];
  items.forEach((btn, i) => {
    const id = order[i];
    const active = s.sidebarVisible && s.activePanel === id;
    btn.classList.toggle("is-active", active);
  });
  const duckyBtn = shell.activityBar.querySelector<HTMLButtonElement>(".activity-item--ducky");
  duckyBtn?.classList.toggle("is-active", s.aiPanelVisible);

  // Sidebar. It is hidden only when the user hides it: the Ducky AI panel
  // sits alongside it, the way it does in a modern AI editor, rather than
  // replacing it.
  shell.sidebar.classList.toggle("is-hidden", !s.sidebarVisible);
  const titleSpan = shell.sidebarTitle.querySelector(".sidebar-title-text");
  if (titleSpan) titleSpan.textContent = TITLES[s.activePanel] ?? "";
  shell.sidebarTitle.style.display = s.sidebarVisible ? "" : "none";

  // Show only the active panel's container, and render only that one. The others
  // keep their DOM (and their scroll position) but cost no work.
  for (const [id, el] of shell.sidebarPanels) {
    el.classList.toggle("is-hidden", !(s.sidebarVisible && id === s.activePanel));
  }
  const activeHost = shell.sidebarPanels.get(s.activePanel);
  const renderView = shell.views.get(s.activePanel);
  if (renderView && activeHost && s.sidebarVisible) {
    renderView(activeHost, s);
  }

  // AI panel.
  shell.aiPanel.classList.toggle("is-hidden", !s.aiPanelVisible);
  if (s.aiPanelVisible) {
    shell.views.get("ducky")?.(shell.aiContent, s);
  }

  // Bottom panel.
  const showBottom = s.bottomPanel !== null;
  shell.bottomPanel.classList.toggle("is-hidden", !showBottom);
  if (showBottom && s.bottomPanel) {
    const render = shell.bottomViews.get(s.bottomPanel);
    if (render) render(shell.bottomContent, s);
  }

  // Toasts.
  renderToasts(shell, s);
}

function renderToasts(shell: Shell, s: State): void {
  const current = shell.toastHost.textContent;
  if (!s.toast) {
    if (current) clear(shell.toastHost);
    return;
  }
  const signature = `${s.toast.kind}:${s.toast.message}`;
  if (shell.toastHost.dataset.signature === signature) return;
  shell.toastHost.dataset.signature = signature;
  fill(
    shell.toastHost,
    h(
      "div",
      { class: `toast toast--${s.toast.kind}` },
      s.toast.kind === "error" ? icons.error(14) : s.toast.kind === "success" ? icons.check(14) : icons.info(14),
      h("span", { class: "toast-text" }, s.toast.message),
      button("", () => {
        store.update((st) => {
          st.toast = null;
        });
      }, { icon: icons.close(12), class: "toast-close", title: "Dismiss" }),
    ),
  );
}

/** Rebuild the bottom panel's tab strip. */
export function renderBottomTabs(shell: Shell, s: State): void {
  const items: { id: NonNullable<State["bottomPanel"]>; label: string; count?: number }[] = [
    { id: "terminal", label: "TERMINAL" },
    {
      id: "problems",
      label: "PROBLEMS",
      count: s.problems.filter((p) => p.severity === "error").length,
    },
    { id: "output", label: "OUTPUT" },
  ];

  fill(
    shell.bottomTabs,
    ...items.map((item) => {
      const active = s.bottomPanel === item.id;
      return h(
        "button",
        {
          class: `bottom-tab${active ? " is-active" : ""}`,
          onClick: () => {
            store.update((st) => {
              st.bottomPanel = st.bottomPanel === item.id ? null : item.id;
            });
          },
        },
        item.label,
        item.count ? h("span", { class: "bottom-tab-count" }, String(item.count)) : null,
      );
    }),
    h("div", { class: "bottom-tab-spacer" }),
    bottomPanelActions(shell, s),
  );
}

function bottomPanelActions(_shell: Shell, s: State): HTMLElement {
  const actions = h("div", { class: "bottom-actions" });
  if (s.bottomPanel === "terminal") {
    actions.appendChild(
      iconBtn("New Terminal", icons.plus(13), () => {
        window.dispatchEvent(new CustomEvent("ducky:new-terminal"));
      }),
    );
    actions.appendChild(
      iconBtn("Clear", icons.trash(13), () => {
        window.dispatchEvent(new CustomEvent("ducky:clear-terminal"));
      }),
    );
  } else if (s.bottomPanel === "problems") {
    actions.appendChild(
      iconBtn("Refresh", icons.refresh(13), () => {
        window.dispatchEvent(new CustomEvent("ducky:refresh-problems"));
      }),
    );
  }
  actions.appendChild(
    iconBtn("Close Panel", icons.close(13), () => {
      store.update((st) => {
        st.bottomPanel = null;
      });
    }),
  );
  return actions;
}

function iconBtn(title: string, icon: SVGElement, onClick: () => void): HTMLElement {
  return h("button", { class: "icon-btn", title, onClick }, icon);
}

export { iconBtn };

/** The welcome / empty-editor surface, shown when no folder is open. */
export function renderWelcome(shell: Shell, s: State, actions: {
  onOpenFolder: () => void;
  onCreateProject: () => void;
  onConnectAI: () => void;
}): void {
  const show = !s.workspace;
  shell.welcomeHost.classList.toggle("is-visible", show);
  if (!show) return;

  const signature = `${s.chat.length}:${s.settings?.ai.provider.hasKey}`;
  if (shell.welcomeHost.dataset.signature === signature) return;
  shell.welcomeHost.dataset.signature = signature;

  const recents = s.settings?.recentWorkspaces ?? [];

  fill(
    shell.welcomeHost,
    h(
      "div",
      { class: "welcome" },
      h("div", { class: "welcome-mark" }, icons.duck(56)),
      h("h1", { class: "welcome-title" }, "Welcome to Ducky Coder Lite"),
      h(
        "p",
        { class: "welcome-subtitle" },
        "A lightweight AI coding environment for low-end PCs.",
      ),
      h(
        "p",
        { class: "welcome-tagline" },
        s.settings?.lowMemory.enabled
          ? "Low Memory Mode is on. Ducky AI runs remotely, so nothing large is loaded on this machine."
          : "Connect Ducky AI to a remote provider, or keep coding without it.",
      ),
      h(
        "div",
        { class: "welcome-actions" },
        primaryAction("Open Folder", icons.folder(14), actions.onOpenFolder),
        primaryAction("Create Project", icons.plus(14), actions.onCreateProject),
        secondaryAction("Connect AI", icons.sparkle(14), actions.onConnectAI),
        secondaryAction("Continue Without AI", icons.arrowRight(14), () => {
          store.update((st) => {
            st.workspace = st.workspace;
          });
        }),
      ),
      recents.length > 0
        ? h(
            "div",
            { class: "welcome-recents" },
            h("div", { class: "welcome-recents-title" }, "RECENT"),
            ...recents.slice(0, 6).map((r) =>
              h(
                "button",
                {
                  class: "welcome-recent",
                  onClick: () => {
                    void api.openFolder(r.path);
                  },
                },
                icons.folder(13),
                h("span", { class: "welcome-recent-name" }, r.name),
                h("span", { class: "welcome-recent-path" }, r.path),
              ),
            ),
          )
        : null,
      h(
        "div",
        { class: "welcome-shortcuts" },
        shortcutRow("Quick Open", "P"),
        shortcutRow("Command Palette", "⇧P"),
        shortcutRow("Search Workspace", "⇧F"),
        shortcutRow("Ducky AI", "⇧A"),
        shortcutRow("Toggle Terminal", "`"),
      ),
    ),
  );
}

function primaryAction(label: string, icon: SVGElement, onClick: () => void): HTMLElement {
  return h("button", { class: "welcome-btn welcome-btn--primary", onClick }, icon, h("span", null, label));
}

function secondaryAction(label: string, icon: SVGElement, onClick: () => void): HTMLElement {
  return h("button", { class: "welcome-btn", onClick }, icon, h("span", null, label));
}

function shortcutRow(label: string, keys: string): HTMLElement {
  return h(
    "div",
    { class: "welcome-shortcut" },
    h("span", null, label),
    h("kbd", null, IS_MAC ? keys.replace("⇧", "⇧") : keys.replace("⇧", "Shift+").replace("`", "`")),
  );
}
