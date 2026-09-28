/**
 * The project explorer.
 *
 * ## Lazy by construction
 *
 * A folder's children are fetched from disk the moment the user expands it, and
 * never before. `TreeNode.children === null` means "not loaded yet". There is no
 * full-project walk anywhere in this file, so a 48,000-file repository costs
 * exactly as much as a 12-file one: the memory used is proportional to what is
 * actually on screen.
 *
 * ## Virtualised rows
 *
 * A folder with 20,000 files would otherwise create 20,000 DOM rows. Rows are
 * built only for the visible window plus a small overscan, and the row elements
 * are pooled and reused, so scrolling a huge directory is a repaint rather than
 * an allocation storm.
 */

import { h, fill, clear, formatBytes, debounce } from "../core/dom";
import { icons, langMonogram } from "./icons";
import { store, openFile, toast, LIMITS, type State, type TreeNode } from "../core/store";
import { api, type FsEntry } from "../core/backend";

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

function nodeFromEntry(entry: FsEntry): TreeNode {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    language: entry.language,
    children: entry.kind === "directory" ? null : [],
    expanded: false,
    size: entry.size,
    hidden: entry.isHidden,
    filteredChildren: entry.hasFilteredChildren,
  };
}

function findNode(root: TreeNode, path: string): TreeNode | null {
  if (root.path === path) return root;
  if (!root.children) return null;
  for (const child of root.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

function parentPathOf(path: string): string {
  const i = path.lastIndexOf("/");
  if (i < 0) return path;
  // Preserve the root: on a path like "/a/b/c" the parent is "/a/b", and for
  // "/a" the parent is "" (the root itself).
  return i === 0 ? "" : path.slice(0, i);
}

/** Load one directory's children. Never loads more than the user asked for. */
export async function expandFolder(path: string): Promise<void> {
  const root = store.state.tree;
  if (!root) return;
  const node = findNode(root, path);
  if (!node) return;
  if (node.children !== null) {
    node.expanded = !node.expanded;
    store.notify();
    return;
  }
  node.expanded = true;
  store.notify();
  try {
    const entries = await api.listDir(path);
    node.children = entries.map((e) => nodeFromEntry(e));
    // Bound the tree: a pathological directory cannot grow the model without
    // limit, and we tell the user rather than silently truncating.
    if (node.children.length > LIMITS.treeRows) {
      node.children = node.children.slice(0, LIMITS.treeRows);
      node.filteredChildren = true;
      toast(
        `This folder has more than ${LIMITS.treeRows.toLocaleString()} entries. Only the first ${LIMITS.treeRows.toLocaleString()} are shown to keep memory low.`,
        "info",
      );
    }
  } catch (err) {
    node.children = [];
    node.expanded = true;
    toast(err instanceof Error ? err.message : String(err), "error");
  }
  store.notify();
}

export async function refreshTree(): Promise<void> {
  const ws = store.state.workspace;
  if (!ws) return;
  try {
    const entries = await api.listDir("");
    // Preserve expansion state across a refresh: a refresh should not collapse
    // the tree the user is working in.
    const previous = new Map<string, TreeNode>();
    if (store.state.tree) collectExpanded(store.state.tree, previous);

    const root: TreeNode = {
      path: ws.root,
      name: ws.name,
      kind: "directory",
      language: "folder",
      children: entries.map((e) => nodeFromEntry(e)),
      expanded: true,
      size: 0,
      hidden: false,
      filteredChildren: entries.some((e) => e.hasFilteredChildren),
    };
    store.update((s) => {
      s.tree = root;
    });
    // Re-load only the directories that were already open.
    for (const [path] of previous) {
      const node = findNode(root, path);
      if (node) await expandFolder(path);
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

function collectExpanded(node: TreeNode, out: Map<string, TreeNode>): void {
  if (node.expanded && node.children) out.set(node.path, node);
  for (const child of node.children ?? []) collectExpanded(child, out);
}

// ---------------------------------------------------------------------------
// Flattened, virtualised row list
// ---------------------------------------------------------------------------

interface Row {
  node: TreeNode;
  depth: number;
}

function flatten(root: TreeNode, out: Row[] = []): Row[] {
  out.push({ node: root, depth: 0 });
  if (root.children) walk(root.children, 1, out);
  return out;
}

function walk(children: TreeNode[], depth: number, out: Row[]): void {
  for (const child of children) {
    out.push({ node: child, depth });
    if (child.expanded && child.children) walk(child.children, depth + 1, out);
  }
}

const ROW_HEIGHT = 22;
const OVERSCAN = 12;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let rowHost: HTMLElement | null = null;
let spacerTop: HTMLElement | null = null;
let spacerBottom: HTMLElement | null = null;
let pooled: HTMLElement[] = [];
let filteredTerm = "";
let collapseAllToken = 0;

export function renderExplorer(host: HTMLElement, s: State): void {
  if (host.dataset.mounted !== "1") {
    host.dataset.mounted = "1";
    buildExplorer(host);
  }

  const count = host.querySelector("#tree-count");
  if (count) count.textContent = s.workspace ? s.workspace.name : "";

  renderRows();
}

function buildExplorer(host: HTMLElement): void {
  rowHost = h("div", { class: "tree-rows" });
  spacerTop = h("div", { class: "tree-spacer" });
  spacerBottom = h("div", { class: "tree-spacer" });

  const scroller = h("div", { class: "tree-scroller" }, spacerTop, rowHost, spacerBottom);
  scroller.addEventListener("scroll", () => renderRows(), { passive: true });

  const filter = h("input", {
    class: "tree-filter",
    type: "text",
    placeholder: "Filter files",
    spellcheck: false,
    onInput: (e: Event) => {
      filteredTerm = (e.target as HTMLInputElement).value.trim().toLowerCase();
      renderRows(true);
    },
  }) as HTMLInputElement;

  host.appendChild(
    h(
      "div",
      { class: "tree-wrap" },
      h(
        "div",
        { class: "tree-toolbar" },
        filter,
        h(
          "div",
          { class: "tree-toolbar-buttons" },
          iconAction("New File", icons.file(13), () => newEntry("file")),
          iconAction("New Folder", icons.folder(13), () => newEntry("directory")),
          iconAction("Refresh", icons.refresh(13), () => void refreshTree()),
          iconAction("Collapse Folders", icons.minus(13), () => collapseAll()),
        ),
      ),
      scroller,
      h(
        "div",
        { class: "tree-status" },
        h("span", { id: "tree-count" }),
        h(
          "span",
          { class: "tree-status-hint", title: "Ducky Coder Lite reads a folder only when you open it." },
          "lazy",
        ),
      ),
    ),
  );
}

function iconAction(title: string, icon: SVGElement, onClick: () => void): HTMLElement {
  return h("button", { class: "icon-btn", title, onClick }, icon);
}

function collapseAll(): void {
  const root = store.state.tree;
  if (!root) return;
  collapseAllToken++;
  const walkDown = (node: TreeNode): void => {
    node.expanded = false;
    for (const child of node.children ?? []) walkDown(child);
  };
  for (const child of root.children ?? []) walkDown(child);
  store.notify();
}

function renderRows(_force = false): void {
  const scroller = rowHost?.parentElement;
  if (!rowHost || !spacerTop || !spacerBottom || !scroller) return;
  const root = store.state.tree;
  if (!root) {
    if (rowHost.childElementCount) clear(rowHost);
    return;
  }

  const all = flatten(root);
  const visible = filteredTerm ? all.filter((r) => r.node.name.toLowerCase().includes(filteredTerm)) : all;

  const total = visible.length;
  spacerTop.style.height = "0px";
  spacerBottom.style.height = "0px";
  // We position rows with a transform inside a fixed-height window; the spacer
  // below reserves the scrollable extent.
  spacerBottom.style.height = `${Math.max(0, total * ROW_HEIGHT - scroller.clientHeight)}px`;

  const scrollTop = scroller.scrollTop;
  const height = scroller.clientHeight || 400;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const count = Math.max(0, last - first);

  // Reuse pooled rows: creating and discarding DOM on every scroll frame is the
  // main source of GC pressure in a naive tree view.
  while (pooled.length < count) {
    const el = h("div", { class: "tree-row" });
    pooled.push(el);
    rowHost.appendChild(el);
  }
  for (let i = count; i < pooled.length; i++) pooled[i].style.display = "none";

  for (let i = 0; i < count; i++) {
    const row = visible[first + i];
    const el = pooled[i];
    paintRow(el, row.node, row.depth, first + i);
  }
}

function paintRow(el: HTMLElement, node: TreeNode, depth: number, index: number): void {
  const isDir = node.kind === "directory";
  const openTab = store.state.tabs.some((t) => t.path === node.path);
  const active = store.state.tabs.find((t) => t.id === store.state.activeTabId)?.path === node.path;
  const dirty = store.state.tabs.find((t) => t.path === node.path)?.dirty ?? false;

  el.style.display = "";
  el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  el.style.paddingLeft = `${8 + depth * 12}px`;
  el.className = `tree-row${openTab ? " is-open" : ""}${active ? " is-active" : ""}${node.hidden ? " is-hidden" : ""}`;
  el.dataset.path = node.path;

  const mono = langMonogram(node.language);
  fill(
    el,
    h(
      "span",
      { class: "tree-twisty" },
      isDir ? (node.expanded ? icons.chevronDown(11) : icons.chevronRight(11)) : null,
    ),
    h(
      "span",
      { class: "tree-icon" },
      isDir ? (node.expanded ? icons.folderOpen(14) : icons.folder(14)) : null,
      !isDir && mono.text
        ? h("span", { class: "file-badge", style: `color:${mono.color}` }, mono.text)
        : null,
    ),
    h("span", { class: "tree-name" }, node.name),
    dirty ? h("span", { class: "tree-dirty" }, "●") : null,
    !isDir && node.size > 0 ? h("span", { class: "tree-size" }, formatBytes(node.size)) : null,
    node.filteredChildren ? h("span", { class: "tree-filtered", title: "Some items here are hidden by the ignore rules" }, "⋯") : null,
  );
}

// ---------------------------------------------------------------------------
// Interactions, delegated on the host so they survive re-renders
// ---------------------------------------------------------------------------

let contextTarget: { path: string; kind: string } | null = null;

export function installExplorerInteractions(host: HTMLElement): void {
  const onClick = async (e: MouseEvent): Promise<void> => {
    const target = (e.target as HTMLElement).closest(".tree-row") as HTMLElement | null;
    if (!target) return;
    const path = target.dataset.path;
    if (!path) return;
    const node = findNode(store.state.tree!, path);
    if (!node) return;

    if (node.kind === "directory") {
      await expandFolder(path);
    } else {
      await openFile(path, { preview: true });
    }
  };

  const onContext = (e: MouseEvent): void => {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest(".tree-row") as HTMLElement | null;
    if (!target?.dataset.path) return;
    contextTarget = { path: target.dataset.path, kind: "item" };
    showContextMenu(e.clientX, e.clientY, target.dataset.path);
  };

  const onDouble = async (e: MouseEvent): Promise<void> => {
    const target = (e.target as HTMLElement).closest(".tree-row") as HTMLElement | null;
    if (!target?.dataset.path) return;
    await promptRename(target.dataset.path);
  };

  const onKey = (e: KeyboardEvent): void => {
    const target = (e.target as HTMLElement).closest(".tree-row") as HTMLElement | null;
    if (!target?.dataset.path) return;
    if (e.key === "F2") {
      e.preventDefault();
      void promptRename(target.dataset.path);
    } else if (e.key === "Delete") {
      e.preventDefault();
      void confirmDelete(target.dataset.path);
    } else if (e.key === "Enter" && !e.ctrlKey) {
      e.preventDefault();
      const node = findNode(store.state.tree!, target.dataset.path);
      if (!node) return;
      if (node.kind === "directory") void expandFolder(node.path);
      else void openFile(node.path, { preview: true });
    }
  };

  host.addEventListener("click", (e) => void onClick(e));
  host.addEventListener("contextmenu", onContext);
  host.addEventListener("dblclick", (e) => void onDouble(e));
  host.addEventListener("keydown", onKey);
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export function showContextMenu(x: number, y: number, path: string): void {
  const isDir = findNode(store.state.tree!, path)?.kind === "directory";
  const items: { label: string; icon: () => SVGElement; run: () => void; danger?: boolean }[] = isDir
    ? [
        { label: "New File", icon: icons.file, run: () => void newEntry("file", path) },
        { label: "New Folder", icon: icons.folder, run: () => void newEntry("directory", path) },
        { label: "Refresh", icon: icons.refresh, run: () => void refreshTree() },
        { label: "Copy Path", icon: icons.copy, run: () => void navigator.clipboard.writeText(path) },
        { label: "Delete Folder", icon: icons.trash, run: () => void confirmDelete(path), danger: true },
      ]
    : [
        { label: "Open", icon: icons.file, run: () => void openFile(path, { preview: true }) },
        { label: "Open to the Side", icon: icons.split, run: () => void openFile(path, { preview: false }) },
        { label: "Rename", icon: icons.edit, run: () => void promptRename(path) },
        { label: "Copy Path", icon: icons.copy, run: () => void navigator.clipboard.writeText(path) },
        {
          label: "Add to AI Context",
          icon: icons.sparkle,
          run: () => {
            store.update((s) => {
              if (!s.pinnedContext.includes(path)) s.pinnedContext.push(path);
            });
            toast("Added to the AI context.", "success");
          },
        },
        { label: "Delete", icon: icons.trash, run: () => void confirmDelete(path), danger: true },
      ];
  openMenu(x, y, items);
}

export interface MenuItem {
  label: string;
  icon?: () => SVGElement;
  /** Not needed on a separator. */
  run?: () => void;
  danger?: boolean;
  separator?: boolean;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
}

/** A single reusable floating menu. */
export function openMenu(x: number, y: number, items: MenuItem[]): void {
  document.querySelector(".floating-menu")?.remove();

  const menu = h(
    "div",
    { class: "floating-menu", style: `left:${x}px;top:${y}px` },
    ...items.map((item) =>
      item.separator
        ? h("div", { class: "menu-sep" })
        : h(
            "button",
            {
              class: `menu-item${item.danger ? " is-danger" : ""}${item.disabled ? " is-disabled" : ""}`,
              disabled: item.disabled,
              onClick: () => {
                menu.remove();
                if (!item.disabled) item.run?.();
              },
            },
            item.icon ? h("span", { class: "menu-icon" }, item.icon()) : null,
            h("span", { class: "menu-label" }, item.label),
            item.checked ? icons.check(12) : null,
            item.shortcut ? h("span", { class: "menu-shortcut" }, item.shortcut) : null,
          ),
    ),
  );

  // Keep the menu on screen.
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 6) {
    menu.style.left = `${Math.max(6, window.innerWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > window.innerHeight - 6) {
    menu.style.top = `${Math.max(6, window.innerHeight - rect.height - 6)}px`;
  }

  const dismiss = (e: Event): void => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
  void contextTarget;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

async function newEntry(kind: "file" | "directory", inFolder?: string): Promise<void> {
  const root = store.state.tree;
  if (!root) {
    toast("Open a folder first.", "info");
    return;
  }
  // The target folder: the selected folder, or the folder of the selected file,
  // or the workspace root.
  let base = inFolder ?? "";
  if (!inFolder) {
    const activePath = store.state.tabs.find((t) => t.id === store.state.activeTabId)?.path;
    if (activePath) {
      const node = findNode(root, activePath);
      base = node ? (node.kind === "directory" ? node.path : parentPathOf(node.path)) : "";
    }
  }
  const name = window.prompt(kind === "file" ? "New file name" : "New folder name", kind === "file" ? "untitled.ts" : "new-folder");
  if (!name) return;

  const full = base ? `${base}/${name}` : name;
  try {
    await api.createEntry(full, kind);
    if (base) await expandFolder(base);
    store.notify();
    if (kind === "file") await openFile(full, { preview: true });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function promptRename(path: string): Promise<void> {
  const current = path.split("/").pop() ?? path;
  const next = window.prompt("Rename to", current);
  if (!next || next === current) return;
  const parent = parentPathOf(path);
  const target = parent ? `${parent}/${next}` : next;
  try {
    await api.renameEntry(path, target);
    // Keep the open tabs pointing at the file the user still cares about.
    store.update((s) => {
      for (const t of s.tabs) if (t.path === path) t.path = target;
    });
    await refreshTree();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

async function confirmDelete(path: string): Promise<void> {
  if (!window.confirm(`Delete ${path.split("/").pop()}?\n\nThis cannot be undone.`)) return;
  try {
    await api.deleteEntry(path);
    store.update((s) => {
      s.tabs = s.tabs.filter((t) => t.path !== path);
      if (!s.tabs.some((t) => t.id === s.activeTabId)) s.activeTabId = s.tabs[0]?.id ?? null;
    });
    await refreshTree();
    toast("Deleted.", "success");
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}

export { findNode, parentPathOf, debounce, collapseAllToken };
