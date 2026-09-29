/**
 * Keyboard handling.
 *
 * The editor is designed to be driven almost entirely from the keyboard, so this
 * module is the primary interface rather than an accessibility afterthought.
 *
 * ## How shortcuts are matched
 *
 * Bindings are resolved through CodeMirror's own keymap when the editor has
 * focus (because only it knows about the current selection state), and through a
 * document-level listener otherwise. Both use the same `matches` function, so a
 * binding behaves identically wherever focus happens to be.
 *
 * ## The interception order matters
 *
 * Single-key bindings (Escape) and palette bindings (Ctrl+Shift+P) are checked
 * before anything else, and terminal input is checked before the global handler.
 * Otherwise typing in a terminal would open the palette, or Escape inside the
 * editor would close a panel the user did not ask to close.
 */

import { IS_MAC } from "../core/dom";

export interface Binding {
  /** Combo string: `mod`, `shift`, `alt`, `ctrl`, then a key. */
  combo: string;
  label: string;
  run: (e: KeyboardEvent) => boolean | void;
  /** Only run when the editor is not focused. */
  globalOnly?: boolean;
  /** Allow the event through even when the terminal has focus. */
  allowInTerminal?: boolean;
}

const MOD = IS_MAC ? "meta" : "ctrl";

/**
 * Canonical name for a key.
 *
 * `KeyboardEvent.key` is the *character* (`\``, `a`, `1`), but bindings are
 * written with the *name* (`backquote`, `arrowup`, `space`) so they read like
 * documentation. Without this table, `Ctrl+\`` compares "`" against
 * "backquote" and never matches, and no arrow key binding would ever fire.
 */
const KEY_ALIASES: Record<string, string> = {
  "`": "backquote",
  "~": "backquote",
  " ": "space",
  spacebar: "space",
  arrowup: "arrowup",
  up: "arrowup",
  arrowdown: "arrowdown",
  down: "arrowdown",
  arrowleft: "arrowleft",
  left: "arrowleft",
  arrowright: "arrowright",
  right: "arrowright",
  escape: "escape",
  esc: "escape",
  enter: "enter",
  return: "enter",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  tab: "tab",
  pageup: "pageup",
  pgup: "pageup",
  pagedown: "pagedown",
  pgdn: "pagedown",
  home: "home",
  end: "end",
  insert: "insert",
};

function canonicalKey(raw: string): string {
  const lower = raw.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

function normalise(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push("meta");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");

  parts.push(canonicalKey(e.key));
  return parts.join("+");
}

function normaliseCombo(combo: string): string {
  const parts = combo.split("+").map((p) => p.toLowerCase());
  const out: string[] = [];
  const key = parts[parts.length - 1]!;
  for (const p of parts.slice(0, -1)) {
    if (p === "mod" || p === "cmd" || p === "meta") out.push("meta");
    else if (p === "ctrl" || p === "control") out.push("ctrl");
    else if (p === "alt" || p === "option") out.push("alt");
    else if (p === "shift") out.push("shift");
  }
  // `mod` is a portability alias: the same binding matches Cmd on macOS and
  // Ctrl elsewhere, which is what users expect from a cross-platform editor.
  if (combo.toLowerCase().includes("mod")) {
    out[0] = IS_MAC ? "meta" : "ctrl";
  }
  out.push(canonicalKey(key));
  return out.join("+");
}

export function comboMatches(e: KeyboardEvent, combo: string): boolean {
  return normalise(e) === normaliseCombo(combo);
}

export class KeyboardManager {
  private bindings: Binding[] = [];

  constructor() {
    for (const b of DEFAULT_BINDINGS) this.bindings.push(b);
  }

  bind(binding: Binding): void {
    this.bindings.push(binding);
  }

  register(bindings: Binding[]): void {
    for (const b of bindings) this.bindings.push(b);
  }

  list(): Binding[] {
    return this.bindings;
  }

  /**
   * Handle a key event from anywhere in the app.
   *
   * Returns true when a binding consumed the event.
   */
  handle(e: KeyboardEvent, context: Context): boolean {
    const inEditor = context.inEditor;
    const inTerminal = context.inTerminal;
    const inInput = context.inInput;

    // Typing in a text field: only honour bindings that explicitly opt in.
    if (inInput && !context.allowInInput) {
      // Escape always closes things, even from an input.
      if (e.key === "Escape") {
        for (const b of this.bindings) {
          if (b.combo === "Escape") {
            b.run(e);
            return true;
          }
        }
      }
      return false;
    }

    for (const b of this.bindings) {
      if (b.globalOnly && inEditor) continue;
      if (inTerminal && !b.allowInTerminal) continue;
      if (!comboMatches(e, b.combo)) continue;
      const result = b.run(e);
      if (result !== false) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
    }
    return false;
  }
}

export interface Context {
  inEditor: boolean;
  inTerminal: boolean;
  inInput: boolean;
  allowInInput?: boolean;
}

export const DEFAULT_BINDINGS: Binding[] = [
  // ---- Palette and quick open --------------------------------------------
  {
    combo: `${MOD}+shift+p`,
    label: "Command Palette",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:command-palette")),
  },
  {
    combo: `${MOD}+p`,
    label: "Quick Open",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:quick-open")),
  },
  {
    combo: `${MOD}+shift+o`,
    label: "Go to File in Project",
    run: () => window.dispatchEvent(new CustomEvent("ducky:quick-open")),
  },

  // ---- AI ----------------------------------------------------------------
  {
    combo: `${MOD}+shift+a`,
    label: "Ducky AI",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:toggle-ai")),
  },
  {
    combo: "mod+i",
    label: "Ducky AI: Edit with AI",
    run: () => window.dispatchEvent(new CustomEvent("ducky:inline-ai")),
  },
  {
    // The editing island. `mod+k` because that is where the muscle memory is:
    // one keystroke, a box over the code, write what you want changed.
    combo: "mod+k",
    label: "Ducky AI: Edit Selection with Ducky",
    run: () => window.dispatchEvent(new CustomEvent("ducky:cmdk")),
  },
  {
    // Send the selection to chat. Separate from `mod+k` because the two answers
    // to a selection are different questions: "change this" and "explain this".
    combo: "mod+l",
    label: "Ducky AI: Send Selection to Chat",
    run: () => window.dispatchEvent(new CustomEvent("ducky:send-selection")),
  },
  {
    combo: "mod+shift+i",
    label: "Ducky AI: Composer",
    run: () => window.dispatchEvent(new CustomEvent("ducky:composer")),
  },

  // ---- Layout ------------------------------------------------------------
  {
    combo: `${MOD}+b`,
    label: "Toggle Sidebar",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:toggle-sidebar")),
  },
  {
    combo: `${MOD}+j`,
    label: "Toggle Bottom Panel",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:toggle-bottom")),
  },
  {
    combo: `${MOD}+backquote`,
    label: "Toggle Terminal",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:toggle-terminal")),
  },
  {
    combo: `${MOD}+shift+backquote`,
    label: "Create a New Terminal",
    run: () => window.dispatchEvent(new CustomEvent("ducky:new-terminal")),
  },
  {
    combo: `${MOD}+shift+m`,
    label: "Toggle Problems Panel",
    run: () => window.dispatchEvent(new CustomEvent("ducky:toggle-problems")),
  },

  // ---- Files -------------------------------------------------------------
  {
    combo: `${MOD}+s`,
    label: "Save",
    run: () => window.dispatchEvent(new CustomEvent("ducky:save")),
  },
  {
    combo: `${MOD}+shift+s`,
    label: "Save All",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:save-all")),
  },
  {
    combo: `${MOD}+w`,
    label: "Close Tab",
    run: () => window.dispatchEvent(new CustomEvent("ducky:close-tab")),
  },
  {
    combo: `${MOD}+shift+t`,
    label: "Reopen Closed Tab",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:reopen-tab")),
  },
  {
    combo: `${MOD}+n`,
    label: "New File",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:new-file")),
  },
  {
    combo: `${MOD}+k`,
    label: "Open Folder",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:open-folder")),
  },

  // ---- Navigation --------------------------------------------------------
  {
    combo: `${MOD}+shift+f`,
    label: "Search Workspace",
    allowInTerminal: true,
    run: () => window.dispatchEvent(new CustomEvent("ducky:focus-search")),
  },
  {
    combo: `${MOD}+g`,
    label: "Go to Line",
    run: () => window.dispatchEvent(new CustomEvent("ducky:goto-line")),
  },
  {
    combo: "f1",
    label: "Show All Commands",
    run: () => window.dispatchEvent(new CustomEvent("ducky:command-palette")),
  },
  {
    combo: "escape",
    label: "Close overlay / stop",
    run: () => {
      window.dispatchEvent(new CustomEvent("ducky:escape"));
    },
  },

  // ---- Tabs --------------------------------------------------------------
  {
    combo: "alt+1",
    label: "Go to Tab 1",
    run: () => window.dispatchEvent(new CustomEvent("ducky:tab-index", { detail: 0 })),
  },
  {
    combo: "alt+2",
    label: "Go to Tab 2",
    run: () => window.dispatchEvent(new CustomEvent("ducky:tab-index", { detail: 1 })),
  },
  {
    combo: "alt+3",
    label: "Go to Tab 3",
    run: () => window.dispatchEvent(new CustomEvent("ducky:tab-index", { detail: 2 })),
  },
  {
    combo: "alt+4",
    label: "Go to Tab 4",
    run: () => window.dispatchEvent(new CustomEvent("ducky:tab-index", { detail: 3 })),
  },
  {
    combo: "alt+5",
    label: "Go to Tab 5",
    run: () => window.dispatchEvent(new CustomEvent("ducky:tab-index", { detail: 4 })),
  },
  {
    combo: `${MOD}+pageup`,
    label: "Previous Tab",
    run: () => window.dispatchEvent(new CustomEvent("ducky:tab-cycle", { detail: -1 })),
  },
  {
    combo: `${MOD}+pagedown`,
    label: "Next Tab",
    run: () => window.dispatchEvent(new CustomEvent("ducky:tab-cycle", { detail: 1 })),
  },
];

/** Bindings the palette shows. The list above is the real registry. */
export function bindingList(): { combo: string; label: string }[] {
  return DEFAULT_BINDINGS.map((b) => ({ combo: b.combo, label: b.label }));
}
