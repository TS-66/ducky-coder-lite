/**
 * Panel resizing.
 *
 * The sidebar and the AI panel are draggable, which the reference requires and
 * which a fixed width cannot do: a long path in the tree and a long diff in the
 * chat panel both need room, and both are useless cramped.
 *
 * Implemented with pointer events rather than a `resize` handle because the
 * window manager's own resize is not the thing being dragged here, and because
 * pointer capture keeps the drag alive when the cursor leaves the 4px strip.
 *
 * The width is clamped so the editor can never be squeezed out of existence.
 * On a small screen the min is the whole available width, which means the panel
 * takes everything and the editor is at its floor -- recoverable, not lost.
 */

/** Bounds, in px. The floor keeps the tree and the chat usable. */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const AI_MIN = 320;
const AI_MAX = 640;

/** The editor's own floor. Below this the code cannot be worked in. */
const EDITOR_FLOOR = 320;

/**
 * Attach a drag handle to a panel's trailing edge.
 *
 * `getMax` is a callback rather than a number because the ceiling depends on the
 * window: on a 1280px screen the sidebar and the AI panel together cannot take
 * more than what is left once the dock and the editor floor are accounted for.
 */
export function installResizer(opts: {
  /** The panel element; gets `is-resizing` while the drag is live. */
  panel: HTMLElement;
  /** Which edge to put the handle on. */
  edge: "right" | "left";
  read: () => number;
  write: (px: number) => void;
  /** The upper bound for the current window width. */
  getMax: () => number;
  /** The lower bound. */
  getMin: () => number;
  /** Called after each committed change, to persist. */
  persist?: () => void;
}): void {
  const handle = document.createElement("div");
  handle.className = `panel-resizer panel-resizer--${opts.edge}`;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", opts.edge === "right" ? "Resize panel" : "Resize panel");
  handle.tabIndex = 0;
  opts.panel.appendChild(handle);

  let startX = 0;
  let startWidth = 0;

  const apply = (px: number): void => {
    // Clamped into the window's ceiling as well as the panel's own bounds: the
    // second limit is what stops a wide panel from eating the editor.
    const ceiling = Math.max(opts.getMin(), opts.getMax());
    opts.write(Math.max(opts.getMin(), Math.min(ceiling, Math.round(px))));
  };

  const onMove = (e: PointerEvent): void => {
    const delta = opts.edge === "right" ? e.clientX - startX : startX - e.clientX;
    apply(startWidth + delta);
  };

  const onUp = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    // Without this the drag also selects the text it sweeps over, which on a
    // 4px handle is several hundred pixels of accidental selection.
    document.body.style.userSelect = "";
    opts.panel.classList.remove("is-resizing");
    opts.persist?.();
  };

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = opts.read();
    opts.panel.classList.add("is-resizing");
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Keyboard resizing. A handle you can only drag is not reachable without a
  // mouse, and the widths are a preference worth keeping accessible.
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 24 : 8;
    const dir = opts.edge === "right" ? 1 : -1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      apply(opts.read() - step * dir);
      opts.persist?.();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      apply(opts.read() + step * dir);
      opts.persist?.();
    } else if (e.key === "Home") {
      e.preventDefault();
      apply(opts.getMin());
      opts.persist?.();
    }
  });

  // Double-click returns to the reference width, which is the one the design
  // was drawn at and the one a shared screenshot will match.
  handle.addEventListener("dblclick", () => {
    opts.write(opts.getMin() === SIDEBAR_MIN ? 240 : 380);
    opts.persist?.();
  });
}

/** How much room the two panels may take together, given the window. */
export function panelCeiling(visible: { sidebar: boolean; ai: boolean }): number {
  const win = window.innerWidth;
  // 48 for the activity dock, 1px of divider per panel edge.
  let chrome = 48 + 16;
  if (visible.sidebar) chrome += 1;
  if (visible.ai) chrome += 1;
  return Math.max(SIDEBAR_MIN, win - chrome - EDITOR_FLOOR);
}

export const BOUNDS = {
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  AI_MIN,
  AI_MAX,
};
