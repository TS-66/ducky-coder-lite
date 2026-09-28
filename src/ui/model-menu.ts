/**
 * The model menu.
 *
 * Opened from the model capsule in the title bar, or with the keybinding the
 * hint row advertises. Three parts, in this order, separated by rules:
 *
 *   a keybinding hint
 *   Auto-select and Thinking, each with a switch
 *   the models themselves, with a tick on the one in use
 *
 * The hint is at the top because the first thing a new user does with a menu is
 * ask "how do I get here without the mouse" -- and the answer is a shortcut, so
 * it belongs where the eye lands first.
 *
 * The model list is derived from real configuration rather than hard-coded: a
 * provider that names one model offers that one, and a provider that names a
 * fast model offers both. Inventing model names the user cannot actually
 * select would be worse than a short list.
 */

import { h, fill, keyCombo } from "../core/dom";
import { store, toast } from "../core/store";
import { api } from "../core/backend";
import type { Command } from "./palette";

/** One entry in the list. */
export interface ModelChoice {
  id: string;
  label: string;
  /** A qualifier shown smaller beside the name, e.g. "MAX" or "fast". */
  tag?: string;
}

/**
 * The models this provider can actually be switched between.
 *
 * A provider configuration names `model` and optionally `fastModel`. Those are
 * the only two that can be selected without inventing an endpoint, so they are
 * the only two offered.
 */
export function modelChoices(): ModelChoice[] {
  const provider = store.state.settings?.ai.provider;
  if (!provider) return [];
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined, tag?: string): void => {
    const name = id?.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ id: name, label: name, tag });
  };
  add(provider.model);
  add(provider.fastModel, "fast");
  return out;
}

let open: HTMLElement | null = null;

export function isModelMenuOpen(): boolean {
  return open !== null;
}

export function closeModelMenu(): void {
  open?.remove();
  open = null;
}

/** A small switch: a track and a knob, no text. */
function toggle(on: boolean, label: string): HTMLElement {
  return h(
    "span",
    { class: `mm-switch${on ? " is-on" : ""}`, role: "switch", "aria-checked": String(on), "aria-label": label },
    h("span", { class: "mm-switch-knob" }),
  );
}

export function openModelMenu(commands: Command[]): void {
  closeModelMenu();

  const ai = store.state.settings?.ai;
  if (!ai) {
    toast("No AI provider is configured yet.", "info");
    return;
  }

  // Focusable so the menu owns the keyboard while it is open. A `role="menu"`
  // that cannot be reached by keyboard is not a menu, and a popup that only
  // closes by clicking elsewhere strands anyone who opened it with the keyboard.
  const menu = h("div", {
    class: "mm",
    role: "menu",
    tabindex: "-1",
    "aria-label": "AI model",
  });
  open = menu;

  const render = (): void => {
    const cfg = store.state.settings!.ai;
    const choices = modelChoices();
    const current = cfg.provider.model;

    const rows: HTMLElement[] = [];

    // The hint: a keybinding, so the menu is reachable without the mouse.
    const paletteKey = commands.find((c) => c.id === "ai.modelMenu")?.shortcut;
    rows.push(
      h(
        "div",
        { class: "mm-hint" },
        h("span", { class: "mm-hint-key" }, paletteKey ? keyCombo(paletteKey) : "—"),
        h("span", null, "for model menu"),
      ),
    );
    rows.push(h("div", { class: "mm-rule" }));

    // The two switches. Both persist immediately: a toggle that needs a Save
    // button is a toggle people stop trusting.
    const switchRow = (
      label: string,
      hint: string,
      on: boolean,
      onChange: () => void,
    ): HTMLElement =>
      h(
        "button",
        {
          class: "mm-row mm-row--switch",
          role: "menuitemcheckbox",
          "aria-checked": String(on),
          title: hint,
          onClick: () => {
            onChange();
            render();
          },
        },
        h("span", { class: "mm-row-label" }, label),
        toggle(on, label),
      );

    rows.push(
      switchRow(
        "Auto-select",
        "Let Ducky choose the model for each turn. Slower on some providers, better on most.",
        cfg.autoSelectModel,
        () => void setAi({ autoSelectModel: !cfg.autoSelectModel }),
      ),
    );
    rows.push(
      switchRow(
        "Thinking",
        "Ask the provider for extended reasoning. Ignored by providers that do not offer it.",
        cfg.thinking,
        () => void setAi({ thinking: !cfg.thinking }),
      ),
    );

    rows.push(h("div", { class: "mm-rule" }));

    if (choices.length === 0) {
      rows.push(h("div", { class: "mm-empty" }, "This provider has no model configured."));
    }

    for (const choice of choices) {
      const selected = choice.id === current;
      rows.push(
        h(
          "button",
          {
            class: `mm-row${selected ? " is-selected" : ""}`,
            role: "menuitemradio",
            "aria-checked": String(selected),
            onClick: () => {
              void setAi({ model: choice.id });
              closeModelMenu();
              toast(`Model set to ${choice.id}.`, "success");
            },
          },
          h(
            "span",
            { class: "mm-row-label" },
            choice.label,
            choice.tag ? h("span", { class: "mm-tag" }, choice.tag) : null,
          ),
          selected ? h("span", { class: "mm-tick" }, "✓") : null,
        ),
      );
    }

    fill(menu, ...rows);
  };

  render();

  // Anchored under the capsule, and dismissed the way every other surface in the
  // app is dismissed.
  const capsule = document.querySelector(".title-model");
  const rect = capsule?.getBoundingClientRect();
  menu.style.top = `${Math.round((rect?.bottom ?? 44) + 4)}px`;
  if (rect) {
    // Keep it on screen when the capsule is near the right edge.
    const width = 260;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    menu.style.left = `${Math.round(left)}px`;
  }

  document.body.appendChild(menu);
  // Focus after append: an element cannot take focus while detached.
  menu.focus();

  const onDown = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) closeModelMenu();
  };
  // Attached to the menu, not the document. The menu holds focus, so this fires
  // for every key the user types, and it cannot be starved by another surface's
  // capture-phase handler on window.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeModelMenu();
      // Focus must go back where it came from, or the keyboard user is left with
      // focus on a removed node and has to tab back from the top of the window.
      menu.querySelector<HTMLElement>(".mm-row.is-selected, .mm-row")
        ?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...menu.querySelectorAll<HTMLElement>(".mm-row")];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown"
      ? (at + 1) % rows.length
      : (at <= 0 ? rows.length : at) - 1;
    rows[next]?.focus();
  };
  // Deferred so the click that opened the menu does not immediately close it.
  window.setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
  }, 0);
  menu.addEventListener("keydown", onKey);

  const cleanup = (): void => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
  menu.addEventListener("remove", cleanup);
  // `remove` on an element that was never attached does not fire, so the normal
  // path is to clean up here as well.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(menu)) {
      cleanup();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Apply a partial AI settings change and persist it. */
async function setAi(patch: Partial<{ model: string; autoSelectModel: boolean; thinking: boolean }>): Promise<void> {
  const settings = store.state.settings;
  if (!settings) return;
  const next = {
    ...settings,
    ai: {
      ...settings.ai,
      ...patch,
      provider: { ...settings.ai.provider, ...(patch.model ? { model: patch.model } : {}) },
    },
  };
  store.update((s) => {
    s.settings = next;
  });
  try {
    await api.updateSettings(next);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
}
