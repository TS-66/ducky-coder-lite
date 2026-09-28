/**
 * The tab strip.
 *
 * Tabs are rendered from a single source of truth and only when the set actually
 * changes; dragging a tab reorders the model and re-renders once. A suspended
 * tab (one whose text was released under memory pressure) shows a distinct
 * marker, because from the user's point of view "this tab reloaded itself" must
 * never be a surprise.
 *
 * Reordering is done by mutating the model and letting `renderTabs` rebuild.
 * The tab count in a normal session is small (a handful to a couple of dozen),
 * and a `DragEvent`-based reorder without a full rebuild is not worth the state
 * complexity here.
 */

import { h, fill, clear } from "../core/dom";
import { icons, langMonogram } from "./icons";
import {
  store,
  activateTab,
  closeTab,
  saveTab,
  type State,
  type Tab,
} from "../core/store";
import { openMenu } from "./explorer";

let signature = "";
let dragId: string | null = null;

export function renderTabs(host: HTMLElement, s: State): void {
  // Cheap change detection: rebuild only when the set, order or dirty flags
  // change, not on every keystroke elsewhere in the app.
  const sig = s.tabs
    .map((t) => `${t.id}:${t.dirty ? 1 : 0}:${t.pinned ? 1 : 0}:${t.suspended ? 1 : 0}:${t.id === s.activeTabId ? 1 : 0}`)
    .join("|");
  if (sig === signature) return;
  signature = sig;

  if (s.tabs.length === 0) {
    clear(host);
    host.classList.add("is-empty");
    return;
  }
  host.classList.remove("is-empty");

  fill(
    host,
    ...s.tabs.map((tab) => renderTab(tab, tab.id === s.activeTabId)),
  );
}

function renderTab(tab: Tab, active: boolean): HTMLElement {
  const mono = langMonogram(tab.language);

  const el = h(
    "div",
    {
      class: `tab${active ? " is-active" : ""}${tab.dirty ? " is-dirty" : ""}${tab.pinned ? " is-pinned" : ""}${tab.suspended ? " is-suspended" : ""}`,
      role: "tab",
      draggable: "true",
      title: tab.suspended
        ? `${tab.path}\nSuspended to save memory. Reopening re-reads it from disk.`
        : tab.path,
      "aria-selected": active ? "true" : "false",
      onClick: () => activateTab(tab.id),
      onAuxClick: (e: MouseEvent) => {
        // Middle-click closes, as in every other editor.
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(tab.id);
        }
      },
      onDblClick: () => {
        // Double-click maximises the editor group; with a single group that means
        // toggling the panels, which is the closest equivalent here.
        store.update((st) => {
          st.sidebarVisible = false;
          st.aiPanelVisible = false;
          st.bottomPanel = null;
        });
      },
      onContextmenu: (e: MouseEvent) => {
        e.preventDefault();
        showTabMenu(e.clientX, e.clientY, tab);
      },
      onDragstart: (e: DragEvent) => {
        dragId = tab.id;
        e.dataTransfer?.setData("text/plain", tab.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      },
      onDragover: (e: DragEvent) => {
        e.preventDefault();
        el.classList.add("is-dragover");
      },
      onDragleave: () => el.classList.remove("is-dragover"),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        el.classList.remove("is-dragover");
        if (!dragId || dragId === tab.id) return;
        reorderTabs(dragId, tab.id);
      },
      onDragend: () => {
        dragId = null;
        el.classList.remove("is-dragover");
      },
    },
    h("span", { class: "tab-icon" }, tab.pinned ? icons.pin(11) : null, mono.text ? h("span", { class: "file-badge", style: `color:${mono.color}` }, mono.text) : null),
    h("span", { class: "tab-name" }, tab.name),
    tab.suspended ? h("span", { class: "tab-suspended", title: "Suspended to save memory" }, "○") : null,
    h(
      "span",
      {
        class: "tab-close",
        role: "button",
        title: tab.dirty ? "Save and close" : "Close",
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          if (tab.dirty) void saveTab(tab.id).then(() => closeTab(tab.id));
          else void closeTab(tab.id);
        },
      },
      tab.dirty ? h("span", { class: "tab-dot" }) : icons.close(11),
    ),
  );

  return el;
}

function reorderTabs(fromId: string, toId: string): void {
  store.update((s) => {
    const from = s.tabs.findIndex((t) => t.id === fromId);
    const to = s.tabs.findIndex((t) => t.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = s.tabs.splice(from, 1);
    s.tabs.splice(to, 0, moved);
  });
  // Force a rebuild.
  signature = "";
}

function showTabMenu(x: number, y: number, tab: Tab): void {
  openMenu(x, y, [
    { label: "Close", icon: icons.close, run: () => void closeTab(tab.id), shortcut: "Ctrl+W" },
    { label: "Close Others", icon: icons.close, run: () => closeOthers(tab.id) },
    { label: "Close All", icon: icons.close, run: () => closeAll() },
    { label: "Close Saved", icon: icons.close, run: () => closeSaved() },
    { separator: true, label: "" },
    {
      label: tab.pinned ? "Unpin Tab" : "Pin Tab",
      icon: icons.pin,
      run: () => {
        store.update((s) => {
          const t = s.tabs.find((x) => x.id === tab.id);
          if (t) t.pinned = !t.pinned;
        });
        signature = "";
      },
    },
    {
      label: "Reveal in Explorer",
      icon: icons.explorer,
      run: () => {
        store.update((s) => {
          s.activePanel = "explorer";
          s.sidebarVisible = true;
          s.aiPanelVisible = false;
        });
        window.dispatchEvent(new CustomEvent("ducky:reveal-in-explorer", { detail: tab.path }));
      },
    },
    { separator: true, label: "" },
    {
      label: "Add to AI Context",
      icon: icons.sparkle,
      run: () => {
        store.update((s) => {
          if (!s.pinnedContext.includes(tab.path)) s.pinnedContext.push(tab.path);
        });
      },
    },
    {
      label: "Copy Path",
      icon: icons.copy,
      run: () => void navigator.clipboard.writeText(tab.path),
    },
    {
      label: "Reveal in Finder / Explorer",
      icon: icons.folderOpen,
      run: () => {
        window.dispatchEvent(new CustomEvent("ducky:reveal-external", { detail: tab.path }));
      },
    },
  ]);
}

function closeOthers(keepId: string): void {
  store.update((s) => {
    s.tabs = s.tabs.filter((t) => t.id === keepId);
    if (!s.tabs.some((t) => t.id === s.activeTabId)) s.activeTabId = keepId;
  });
  signature = "";
}

function closeAll(): void {
  store.update((s) => {
    s.tabs = [];
    s.activeTabId = null;
  });
  signature = "";
}

function closeSaved(): void {
  store.update((s) => {
    s.tabs = s.tabs.filter((t) => t.dirty);
    if (!s.tabs.some((t) => t.id === s.activeTabId)) s.activeTabId = s.tabs[0]?.id ?? null;
  });
  signature = "";
}

export function resetTabSignature(): void {
  signature = "";
}
