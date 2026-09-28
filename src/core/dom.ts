/**
 * A ~60-line hyperscript helper.
 *
 * Why not a framework: on a 2 GB machine every kilobyte of framework runtime is
 * memory that is not available to open documents. The UI here is a fixed,
 * well-understood set of panels, so a direct-DOM approach with surgical updates
 * is both smaller and faster than a virtual DOM diff — and it makes the memory
 * cost of the UI legible: what is in the DOM is what exists.
 *
 * `h` returns a real element. Updates are explicit and local, which keeps
 * re-render work proportional to what actually changed.
 */

type Child = Node | string | number | null | undefined | false | Child[];

export interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  html?: string;
  value?: string;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  tabIndex?: number;
  role?: string;
  spellcheck?: boolean;
  autocomplete?: string;
  autofocus?: boolean;
  [key: string]: unknown;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an element with attributes and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

/** Create an SVG element (icons). */
export function svg(tag: string, attrs?: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
  }
  return el;
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "html") {
      el.innerHTML = String(value);
    } else if (key === "style") {
      if (typeof value === "string") {
        el.setAttribute("style", value);
      } else {
        Object.assign(el.style, value);
      }
    } else if (key === "class") {
      el.className = String(value);
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "dataset" && typeof value === "object") {
      Object.assign(el.dataset, value as Record<string, string>);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(el, child);
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** Replace an element's children in one shot. */
export function fill(el: HTMLElement, ...children: Child[]): void {
  el.textContent = "";
  append(el, children);
}

/** Remove all children. */
export function clear(el: HTMLElement): void {
  el.textContent = "";
}

/** A button with an icon and a label. */
export function button(
  label: string,
  onClick: () => void,
  opts: { icon?: SVGElement; title?: string; class?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const el = h(
    "button",
    {
      class: `btn ${opts.class ?? ""}`.trim(),
      title: opts.title ?? label,
      ...(opts.disabled ? { disabled: true } : {}),
      onClick: (e: Event) => {
        e.stopPropagation();
        onClick();
      },
    },
    opts.icon ?? null,
    label ? h("span", null, label) : null,
  );
  return el;
}

/** Debounce, used for search-as-you-type and autocomplete. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel(): void; flush(): void } {
  let timer: number | undefined;
  let pending: A | null = null;

  const wrapped = (...args: A): void => {
    pending = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      const a = pending;
      pending = null;
      if (a) fn(...a);
    }, ms);
  };

  wrapped.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = null;
  };

  wrapped.flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      const a = pending;
      pending = null;
      if (a) fn(...a);
    }
  };

  return wrapped;
}

/** Coalesce bursts of calls into one per animation frame. */
export function raf(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

/** Format a byte count compactly. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a token count compactly. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

/** Escape a string for safe insertion into HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `true` when the platform uses ⌘ rather than Ctrl for shortcuts. */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Render a key combination for display, using the platform's modifier names. */
export function keyCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      const p = part.toLowerCase();
      if (p === "mod") return IS_MAC ? "⌘" : "Ctrl";
      if (p === "shift") return IS_MAC ? "⇧" : "Shift";
      if (p === "alt") return IS_MAC ? "⌥" : "Alt";
      if (p === "ctrl") return IS_MAC ? "⌃" : "Ctrl";
      if (p === "enter") return "↵";
      if (p === "escape") return "Esc";
      if (p === "backquote") return IS_MAC ? "`" : "`";
      if (p === "arrowup") return "↑";
      if (p === "arrowdown") return "↓";
      if (p === "arrowleft") return "←";
      if (p === "arrowright") return "→";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(IS_MAC ? "" : "+");
}
