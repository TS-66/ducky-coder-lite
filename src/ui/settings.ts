/**
 * Settings.
 *
 * A modal rather than a separate tab, so it can be opened from anywhere without
 * disturbing the layout. Every control writes through the store to the backend
 * and the change takes effect immediately: turning on Low Memory Mode while a
 * dozen tabs are open really does suspend them, on the spot.
 *
 * Secrets get special treatment. The API key field is write-only: it can be
 * replaced and cleared, but the stored value is never sent back to the UI, so
 * there is no code path that could put a credential on screen.
 */

import { h } from "../core/dom";
import { icons } from "./icons";
import { store, toast, applySettingsToDom, type State } from "../core/store";
import { api, type ProviderKind } from "../core/backend";
import { showModal } from "./ai-panel";

type Section = "general" | "lowMemory" | "ai" | "editor" | "terminal" | "search" | "performance";

let currentSection: Section = "general";

const SECTIONS: { id: Section; label: string; icon: () => SVGElement }[] = [
  { id: "general", label: "General", icon: icons.settings },
  { id: "lowMemory", label: "Low Memory Mode", icon: icons.memory },
  { id: "ai", label: "Ducky AI", icon: icons.sparkle },
  { id: "editor", label: "Editor", icon: icons.file },
  { id: "terminal", label: "Terminal", icon: icons.terminal },
  { id: "search", label: "Search", icon: icons.search },
  { id: "performance", label: "Performance", icon: icons.cpu },
];

export function openSettings(section: Section = "general"): void {
  currentSection = section;
  render();
}

/**
 * Apply a change to the settings.
 *
 * The mutator is given a single object shaped like `State` so every call site
 * reads as `save((st) => { st.settings!.lowMemory.enabled = v; })`. The draft is
 * a deep clone, so a failed write can never leave the live settings half-updated.
 */
function save(mutate: (s: State) => void): void {
  const current = store.state.settings;
  if (!current) return;
  const draft = structuredClone(current);
  mutate({ settings: draft } as State);
  void api.updateSettings(draft)
    .then((saved) => {
      store.update((s) => {
        s.settings = saved;
      });
      applySettingsToDom(saved);
      render();
    })
    .catch((err: unknown) => {
      toast(err instanceof Error ? err.message : String(err), "error");
    });
}

function render(): void {
  const s = store.state.settings;
  if (!s) return;

  const nav = h(
    "div",
    { class: "settings-nav" },
    ...SECTIONS.map((sec) =>
      h(
        "button",
        {
          class: `settings-nav-item${currentSection === sec.id ? " is-active" : ""}`,
          onClick: () => {
            currentSection = sec.id;
            render();
          },
        },
        sec.icon(),
        h("span", null, sec.label),
      ),
    ),
  );

  const content = h("div", { class: "settings-content" }, ...sectionContent(s));

  showModal("Settings", h("div", { class: "settings" }, nav, content));
}

function sectionContent(s: NonNullable<State["settings"]>): HTMLElement[] {
  switch (currentSection) {
    case "lowMemory":
      return lowMemorySection(s);
    case "ai":
      return aiSection(s);
    case "editor":
      return editorSection(s);
    case "terminal":
      return terminalSection(s);
    case "search":
      return searchSection(s);
    case "performance":
      return performanceSection(s);
    default:
      return generalSection(s);
  }
}

function group(title: string, description: string | null, ...rows: (HTMLElement | null)[]): HTMLElement {
  return h(
    "div",
    { class: "settings-group" },
    h("h3", { class: "settings-group-title" }, title),
    description ? h("p", { class: "settings-group-desc" }, description) : null,
    ...rows.filter(Boolean) as HTMLElement[],
  );
}

function toggle(
  label: string,
  description: string,
  value: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const input = h("input", {
    type: "checkbox",
    checked: value,
    onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
  return h(
    "label",
    { class: "setting setting--toggle" },
    h(
      "span",
      { class: "setting-main" },
      h("span", { class: "setting-label" }, label),
      description ? h("span", { class: "setting-desc" }, description) : null,
    ),
    input,
    h("span", { class: "setting-switch" }),
  );
}

function slider(
  label: string,
  description: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  onChange: (v: number) => void,
): HTMLElement {
  const out = h("span", { class: "setting-value mono" }, `${value}${unit}`);
  const input = h("input", {
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    onInput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      out.textContent = `${v}${unit}`;
      onChange(v);
    },
  });
  return h(
    "div",
    { class: "setting setting--slider" },
    h(
      "span",
      { class: "setting-main" },
      h("span", { class: "setting-label" }, label),
      description ? h("span", { class: "setting-desc" }, description) : null,
    ),
    h("span", { class: "setting-control" }, input, out),
  );
}

function textField(
  label: string,
  description: string,
  value: string,
  placeholder: string,
  onChange: (v: string) => void,
  options: { type?: string; mono?: boolean; secret?: boolean } = {},
): HTMLElement {
  return h(
    "div",
    { class: "setting" },
    h(
      "span",
      { class: "setting-main" },
      h("span", { class: "setting-label" }, label),
      description ? h("span", { class: "setting-desc" }, description) : null,
    ),
    h("input", {
      class: `setting-input${options.mono ? " mono" : ""}`,
      type: options.type ?? "text",
      value,
      placeholder,
      autocomplete: "off",
      spellcheck: false,
      ...(options.secret ? { value: value ? "••••••••••••••••" : "" } : {}),
      onChange: (e: Event) => onChange((e.target as HTMLInputElement).value),
    }),
  );
}

function selectField(
  label: string,
  description: string,
  value: string,
  options: { value: string; label: string }[],
  onChange: (v: string) => void,
): HTMLElement {
  return h(
    "div",
    { class: "setting" },
    h(
      "span",
      { class: "setting-main" },
      h("span", { class: "setting-label" }, label),
      description ? h("span", { class: "setting-desc" }, description) : null,
    ),
    h(
      "select",
      { class: "setting-input", onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
      ...options.map((o) =>
        h("option", { value: o.value, ...(o.value === value ? { selected: true } : {}) }, o.label),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function generalSection(s: NonNullable<State["settings"]>): HTMLElement[] {
  return [
    group(
      "Low Memory Mode",
      "Ducky Coder Lite is built for 2 GB of RAM. This mode is the difference between an editor that stays responsive and one that does not. It is on by default.",
      toggle(
        "Enable Low Memory Mode",
        "Disables the minimap and animations, reduces syntax analysis and autocomplete frequency, limits indexing, suspends inactive tabs, and shrinks caches and terminal history.",
        s.lowMemory.enabled,
        (v) => {
          save((st) => {
            st.settings!.lowMemory.enabled = v;
          });
          store.releaseMemory(v);
          toast(v ? "Low Memory Mode on." : "Low Memory Mode off.", "success");
        },
      ),
    ),
    group(
      "Performance indicator",
      "Show real memory and AI status numbers in the status bar.",
      toggle(
        "Show RAM and AI status",
        "Displays the measured memory used by Ducky Coder Lite and the AI connection state. The numbers are read from the operating system, not estimated.",
        s.showPerformanceIndicator,
        (v) => {
          save((st) => {
            st.settings!.showPerformanceIndicator = v;
          });
        },
      ),
    ),
    group(
      "Privacy",
      "Your code is never uploaded unless you send a request to the AI provider.",
      toggle(
        "Allow Ducky AI to read project files",
        "When off, Ducky AI receives only the text you type or select — it will not retrieve any file from disk to build context.",
        s.ai.autoContext,
        (v) => {
          save((st) => {
            st.settings!.ai.autoContext = v;
          });
        },
      ),
    ),
  ];
}

function lowMemorySection(s: NonNullable<State["settings"]>): HTMLElement[] {
  const mem = store.state.mem;
  return [
    group(
      "Current state",
      mem
        ? `Ducky Coder Lite is using ${mem.appTotalMb.toFixed(0)} MB right now (editor ${mem.processRssMb.toFixed(0)} MB, web view ${mem.webviewRssMb.toFixed(0)} MB). ${mem.systemAvailableMb.toFixed(0)} MB is free on a ${mem.systemTotalMb.toFixed(0)} MB machine.`
        : "Reading memory…",
      h(
        "div",
        { class: "mem-bars" },
        memBar("Editor process", mem?.processRssMb ?? 0, 400, "var(--info)"),
        memBar("Web view", mem?.webviewRssMb ?? 0, 400, "var(--accent)"),
        memBar("System used", mem?.systemUsedMb ?? 0, mem?.systemTotalMb ?? 2048, "var(--err)"),
        memBar("System free", mem?.systemAvailableMb ?? 0, mem?.systemTotalMb ?? 2048, "var(--ok)"),
      ),
    ),
    group(
      "Automatic memory protection",
      "Ducky Coder Lite watches free memory and sheds work automatically when it runs short. You do not need to configure this.",
      slider(
        "Start reducing activity below",
        "Free memory, in MB. Below this, caches are trimmed and background indexing stops.",
        s.lowMemory.shedThresholdMb,
        64,
        1024,
        32,
        " MB",
        (v) => {
          save((st) => {
            st.settings!.lowMemory.shedThresholdMb = v;
          });
        },
      ),
      slider(
        "Critical threshold",
        "Free memory, in MB. Below this, inactive tabs are suspended and AI context is shrunk.",
        s.lowMemory.criticalThresholdMb,
        32,
        512,
        32,
        " MB",
        (v) => {
          save((st) => {
            st.settings!.lowMemory.criticalThresholdMb = Math.min(v, s.lowMemory.shedThresholdMb - 32);
          });
        },
      ),
      toggle(
        "Show a notice when memory runs low",
        "Displays a message explaining what Ducky Coder Lite changed on your behalf.",
        s.lowMemory.showNotice,
        (v) => {
          save((st) => {
            st.settings!.lowMemory.showNotice = v;
          });
        },
      ),
    ),
    group(
      "Documents",
      "Only the active tab is ever parsed and rendered. These settings control how many other tabs keep their text in memory.",
      toggle(
        "Suspend inactive tabs",
        "When off, every open tab keeps its text in memory. On a 2 GB machine this is the single largest consumer.",
        s.lowMemory.suspendInactiveTabs,
        (v) => {
          save((st) => {
            st.settings!.lowMemory.suspendInactiveTabs = v;
          });
          store.enforceTabBudget();
        },
      ),
      slider(
        "Tabs kept warm",
        "Beyond this, tabs are suspended and re-read from disk when reopened. 0 means nothing stays loaded.",
        s.lowMemory.warmTabLimit,
        0,
        10,
        1,
        "",
        (v) => {
          save((st) => {
            st.settings!.lowMemory.warmTabLimit = v;
          });
          store.enforceTabBudget();
        },
      ),
    ),
    group(
      "Rendering and analysis",
      "The editor renders only the visible part of a file, so a very large file costs about the same as a small one. These limits apply to the work around it.",
      slider(
        "Maximum lines to render",
        "Above this, detailed analysis is skipped for a file.",
        s.lowMemory.maxRenderLines,
        2000,
        100000,
        1000,
        " lines",
        (v) => {
          save((st) => {
            st.settings!.lowMemory.maxRenderLines = v;
            st.settings!.editor.renderLineLimit = v;
          });
        },
      ),
      toggle(
        "Suspend language services when memory is low",
        "Stops autocomplete and diagnostics while the machine is under pressure.",
        s.lowMemory.suspendLanguageServices,
        (v) => {
          save((st) => {
            st.settings!.lowMemory.suspendLanguageServices = v;
          });
        },
      ),
      toggle(
        "Pause background indexing",
        "Keeps the folder tree responsive by not pre-reading directories you have not opened.",
        s.lowMemory.pauseBackgroundIndexing,
        (v) => {
          save((st) => {
            st.settings!.lowMemory.pauseBackgroundIndexing = v;
          });
        },
      ),
    ),
    group(
      "Limits under pressure",
      "Smaller numbers mean less memory and slightly slower results.",
      slider(
        "Maximum search results",
        "Search stops once this many matches are found.",
        s.lowMemory.maxSearchResults,
        50,
        5000,
        50,
        "",
        (v) => {
          save((st) => {
            st.settings!.lowMemory.maxSearchResults = v;
          });
        },
      ),
      slider(
        "Terminal scrollback lines",
        "Older terminal output is discarded past this point.",
        s.lowMemory.terminalScrollback,
        50,
        5000,
        50,
        " lines",
        (v) => {
          save((st) => {
            st.settings!.lowMemory.terminalScrollback = v;
          });
        },
      ),
    ),
  ];
}

function memBar(label: string, value: number, max: number, color: string): HTMLElement {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return h(
    "div",
    { class: "mem-bar" },
    h("span", { class: "mem-bar-label" }, label),
    h(
      "span",
      { class: "mem-bar-track" },
      h("span", { class: "mem-bar-fill", style: `width:${pct}%;background:${color}` }),
    ),
    h("span", { class: "mem-bar-value mono" }, `${value.toFixed(0)} MB`),
  );
}

function aiSection(s: NonNullable<State["settings"]>): HTMLElement[] {
  const p = s.ai.provider;
  const rows: HTMLElement[] = [
    selectField(
      "Provider",
      "All inference runs remotely. Ducky Coder Lite never loads a language model onto this machine.",
      p.kind,
      [
        { value: "ducky", label: "Ducky AI (hosted)" },
        { value: "openAicompatible", label: "OpenAI-compatible endpoint" },
        { value: "ollama", label: "Ollama (local server, another machine is fine)" },
        { value: "localServer", label: "Local OpenAI-compatible server" },
      ],
      (v) => {
        const kind = v as ProviderKind;
        save((st) => {
          st.settings!.ai.provider.kind = kind;
          st.settings!.ai.provider.baseUrl = defaultBaseUrl(kind);
        });
      },
    ),
    textField(
      "Base URL",
      "The endpoint Ducky Coder Lite sends requests to.",
      p.baseUrl,
      "https://api.example.com/v1",
      (v) => {
        save((st) => {
          st.settings!.ai.provider.baseUrl = v.replace(/\/+$/, "");
        });
      },
      { mono: true },
    ),
    textField(
      "Model",
      "The model used for chat, edits and agent work.",
      p.model,
      "gpt-4o-mini",
      (v) => {
        save((st) => {
          st.settings!.ai.provider.model = v;
        });
      },
      { mono: true },
    ),
    textField(
      "Fast model",
      "A smaller, quicker model used for autocomplete. Using one saves money and returns faster.",
      p.fastModel,
      "gpt-4o-mini",
      (v) => {
        save((st) => {
          st.settings!.ai.provider.fastModel = v;
        });
      },
      { mono: true },
    ),
  ];

  // The key field. Write-only by design.
  const keyInput = h("input", {
    class: "setting-input mono",
    type: "password",
    placeholder: p.hasKey ? "A key is saved. Type to replace it." : "Paste your API key",
    autocomplete: "off",
    spellcheck: false,
  }) as HTMLInputElement;

  rows.push(
    h(
      "div",
      { class: "setting" },
      h(
        "span",
        { class: "setting-main" },
        h("span", { class: "setting-label" }, "API key"),
        h(
          "span",
          { class: "setting-desc" },
          p.hasKey
            ? "A key is saved on this machine. It is never displayed, logged, or included in any AI request as context."
            : "Stored in a file only your user account can read. It is never sent anywhere except to the provider above.",
        ),
      ),
      h(
        "div",
        { class: "setting-control-row" },
        keyInput,
        h(
          "button",
          {
            class: "btn btn--primary",
            onClick: async () => {
              const key = keyInput.value.trim();
              if (!key) {
                toast("Paste a key first.", "info");
                return;
              }
              try {
                await api.setSecret(p.id, key);
                keyInput.value = "";
                toast("API key saved.", "success");
                await testConnection();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), "error");
              }
            },
          },
          h("span", null, "Save"),
        ),
        p.hasKey
          ? h(
              "button",
              {
                class: "btn",
                onClick: async () => {
                  if (!window.confirm("Remove the saved API key?")) return;
                  await api.clearSecret(p.id);
                  keyInput.value = "";
                  toast("API key removed.", "success");
                },
              },
              h("span", null, "Remove"),
            )
          : null,
        h(
          "button",
          {
            class: "btn",
            onClick: () => void testConnection(),
          },
          h("span", null, store.state.aiTesting ? "Testing…" : "Test"),
        ),
      ),
    ),
  );

  return [
    group("Ducky AI provider", "Configure any OpenAI-compatible endpoint. The editor works with or without one.", ...rows),
    group(
      "Agent behaviour",
      "What Ducky AI is allowed to do on your behalf.",
      toggle(
        "Always ask before applying edits",
        "Shows a diff and waits for you to accept. Strongly recommended.",
        s.ai.agentRequiresApproval,
        (v) => {
          save((st) => {
            st.settings!.ai.agentRequiresApproval = v;
          });
        },
      ),
      toggle(
        "Let Ducky AI suggest commands",
        "Commands still require explicit approval, and destructive ones are flagged.",
        s.ai.agentCanRunCommands,
        (v) => {
          save((st) => {
            st.settings!.ai.agentCanRunCommands = v;
          });
        },
      ),
    ),
    group(
      "Context budget",
      "This is what keeps both your RAM and your provider bill under control. Ducky Coder Lite retrieves only the files that match your request.",
      slider(
        "Maximum files in context",
        "How many files may be sent for a single question.",
        s.ai.maxContextFiles,
        1,
        30,
        1,
        " files",
        (v) => {
          save((st) => {
            st.settings!.ai.maxContextFiles = v;
          });
        },
      ),
      slider(
        "Maximum context tokens",
        "The hard cap per request. Nothing is sent beyond this.",
        p.maxContextTokens,
        1000,
        200000,
        1000,
        " tokens",
        (v) => {
          save((st) => {
            st.settings!.ai.provider.maxContextTokens = v;
          });
        },
      ),
      slider(
        "Maximum characters per file",
        "Large files are sent as an excerpt around the matching code.",
        s.ai.maxFileChars,
        2000,
        100000,
        1000,
        " chars",
        (v) => {
          save((st) => {
            st.settings!.ai.maxFileChars = v;
          });
        },
      ),
    ),
    group(
      "Autocomplete",
      "Requests are debounced, cancelled and only made where a completion makes sense.",
      toggle(
        "Enable AI autocomplete",
        "Suggests code as you type, using the fast model.",
        s.ai.autocompleteEnabled,
        (v) => {
          save((st) => {
            st.settings!.ai.autocompleteEnabled = v;
          });
        },
      ),
      slider(
        "Debounce",
        "How long typing must pause before a request is sent. Higher is cheaper and calmer on slow machines.",
        s.ai.autocompleteDebounceMs,
        100,
        2000,
        50,
        " ms",
        (v) => {
          save((st) => {
            st.settings!.ai.autocompleteDebounceMs = v;
          });
        },
      ),
    ),
    group(
      "Conversation memory",
      "AI history is never written to disk, and it is compressed rather than allowed to grow.",
      slider(
        "Character budget per conversation",
        "Older turns are compressed once the conversation exceeds this.",
        s.ai.historyCharBudget,
        20000,
        1000000,
        10000,
        " chars",
        (v) => {
          save((st) => {
            st.settings!.ai.historyCharBudget = v;
          });
        },
      ),
      slider(
        "Compress after this many messages",
        "",
        s.ai.historyMessageThreshold,
        6,
        100,
        2,
        " messages",
        (v) => {
          save((st) => {
            st.settings!.ai.historyMessageThreshold = v;
          });
        },
      ),
    ),
  ];
}

function defaultBaseUrl(kind: ProviderKind): string {
  switch (kind) {
    case "ducky": return "https://api.duckycoder.ai/v1";
    case "openAicompatible": return "https://api.openai.com/v1";
    case "ollama": return "http://127.0.0.1:11434";
    case "localServer": return "http://127.0.0.1:1234/v1";
  }
}

async function testConnection(): Promise<void> {
  store.update((s) => {
    s.aiTesting = true;
  });
  render();
  try {
    const result = await api.aiTest();
    store.update((s) => {
      s.aiConnected = result.ok;
      s.aiTesting = false;
    });
    toast(result.message, result.ok ? "success" : "error");
  } catch (err) {
    store.update((s) => {
      s.aiConnected = false;
      s.aiTesting = false;
    });
    toast(err instanceof Error ? err.message : String(err), "error");
  }
  render();
}

function editorSection(s: NonNullable<State["settings"]>): HTMLElement[] {
  const e = s.editor;
  return [
    group(
      "Appearance",
      null,
      slider("Font size", "", e.fontSize, 10, 22, 1, " px", (v) => {
        save((st) => { st.settings!.editor.fontSize = v; });
        document.documentElement.style.setProperty("--editor-font-size", `${v}px`);
      }),
      slider("Line height", "", e.lineHeight, 1.1, 2.2, 0.05, "", (v) => {
        save((st) => { st.settings!.editor.lineHeight = v; });
        document.documentElement.style.setProperty("--editor-line-height", String(v));
      }),
      textField("Font family", "A comma-separated CSS font stack for the editor.", e.fontFamily, "ui-monospace, monospace", (v) => {
        save((st) => { st.settings!.editor.fontFamily = v; });
        document.documentElement.style.setProperty("--font-mono", v);
      }, { mono: true }),
    ),
    group(
      "Editing",
      null,
      toggle("Line numbers", "", e.lineNumbers, (v) => {
        save((st) => { st.settings!.editor.lineNumbers = v; });
      }),
      toggle("Bracket matching", "", e.bracketMatching, (v) => {
        save((st) => { st.settings!.editor.bracketMatching = v; });
      }),
      toggle("Word wrap", "Long lines wrap instead of scrolling horizontally.", e.wordWrap, (v) => {
        save((st) => { st.settings!.editor.wordWrap = v; });
      }),
      toggle(
        "Minimap",
        "Off by default. It costs memory and screen space, and offers little on a small display.",
        e.minimap,
        (v) => {
          save((st) => { st.settings!.editor.minimap = v; });
        },
      ),
      toggle("Format on save", "Normalises whitespace and trailing newlines when you save.", e.formatOnSave, (v) => {
        save((st) => { st.settings!.editor.formatOnSave = v; });
      }),
    ),
    group(
      "Indentation",
      null,
      slider("Tab size", "", e.tabSize, 1, 8, 1, " spaces", (v) => {
        save((st) => { st.settings!.editor.tabSize = v; });
      }),
    ),
    group(
      "Large files",
      "Very large files get reduced analysis so the editor stays responsive.",
      slider(
        "Large file threshold",
        "Above this size, a file is opened with limited analysis.",
        e.largeFileBytes,
        100000,
        8000000,
        100000,
        " bytes",
        (v) => {
          save((st) => { st.settings!.editor.largeFileBytes = v; });
        },
      ),
      slider(
        "Refuse above",
        "Above this size, a file is not opened in the editor at all.",
        e.hugeFileBytes,
        1000000,
        50000000,
        500000,
        " bytes",
        (v) => {
          save((st) => { st.settings!.editor.hugeFileBytes = Math.max(v, e.largeFileBytes * 2); });
        },
      ),
    ),
  ];
}

function terminalSection(s: NonNullable<State["settings"]>): HTMLElement[] {
  const t = s.terminal;
  return [
    group(
      "Shell",
      null,
      textField("Shell", "The program Ducky Coder Lite runs in the integrated terminal.", t.shell, "/bin/bash", (v) => {
        save((st) => { st.settings!.terminal.shell = v; });
      }, { mono: true }),
      textField("Arguments", "Space-separated arguments passed to the shell.", t.args.join(" "), "-l", (v) => {
        save((st) => { st.settings!.terminal.args = v.split(/\s+/).filter(Boolean); });
      }, { mono: true }),
    ),
    group(
      "Display",
      "Scrollback is capped. A build that prints hundreds of thousands of lines will not be able to exhaust your memory.",
      slider(
        "Scrollback lines",
        "Older output is discarded past this many lines.",
        t.scrollbackLines,
        100,
        10000,
        50,
        " lines",
        (v) => {
          save((st) => { st.settings!.terminal.scrollbackLines = v; });
        },
      ),
      slider("Font size", "", t.fontSize, 9, 20, 1, " px", (v) => {
        save((st) => { st.settings!.terminal.fontSize = v; });
      }),
      toggle("Cursor blink", "", t.cursorBlink, (v) => {
        save((st) => { st.settings!.terminal.cursorBlink = v; });
      }),
      toggle("Copy on select", "", t.copyOnSelect, (v) => {
        save((st) => { st.settings!.terminal.copyOnSelect = v; });
      }),
    ),
  ];
}

function searchSection(s: NonNullable<State["settings"]>): HTMLElement[] {
  return [
    group(
      "Results",
      null,
      slider("Maximum results", "Search stops once this many matches are found.", s.search.maxResults, 50, 20000, 50, "", (v) => {
        save((st) => { st.settings!.search.maxResults = v; });
      }),
      slider(
        "Skip files larger than",
        "Bundles, logs and generated files are skipped past this size.",
        s.search.maxFileBytes,
        100000,
        10000000,
        100000,
        " bytes",
        (v) => {
          save((st) => { st.settings!.search.maxFileBytes = v; });
        },
      ),
    ),
    group(
      "Default matching",
      null,
      toggle("Match case", "", s.search.caseSensitive, (v) => {
        save((st) => { st.settings!.search.caseSensitive = v; });
      }),
      toggle("Whole word", "", s.search.wholeWord, (v) => {
        save((st) => { st.settings!.search.wholeWord = v; });
      }),
      toggle("Use regular expressions", "", s.search.useRegex, (v) => {
        save((st) => { st.settings!.search.useRegex = v; });
      }),
    ),
    group(
      "Excluded folders",
      "These are skipped by search and hidden in the explorer. One glob per line, using ** for any depth.",
      h(
        "textarea",
        {
          class: "setting-textarea mono",
          rows: 10,
          spellcheck: false,
          value: s.search.excludeGlobs.join("\n"),
          onChange: (e: Event) => {
            const lines = (e.target as HTMLTextAreaElement).value
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            save((st) => {
              st.settings!.search.excludeGlobs = lines;
            });
          },
        },
      ),
    ),
  ];
}

function performanceSection(s: NonNullable<State["settings"]>): HTMLElement[] {
  const mem = store.state.mem;
  return [
    group(
      "Measured now",
      "These numbers are read directly from the operating system.",
      h(
        "div",
        { class: "perf-table mono" },
        perfRow("Editor process RSS", mem ? `${mem.processRssMb.toFixed(1)} MB` : "—"),
        perfRow("Web view RSS", mem ? `${mem.webviewRssMb.toFixed(1)} MB` : "—"),
        perfRow("Total for Ducky Coder Lite", mem ? `${mem.appTotalMb.toFixed(1)} MB` : "—"),
        perfRow("Threads", mem ? String(mem.threadCount) : "—"),
        perfRow("System total", mem ? `${mem.systemTotalMb.toFixed(0)} MB` : "—"),
        perfRow("System used", mem ? `${mem.systemUsedMb.toFixed(0)} MB` : "—"),
        perfRow("System available", mem ? `${mem.systemAvailableMb.toFixed(0)} MB` : "—"),
        perfRow("Swap in use", mem ? `${mem.swapUsedMb.toFixed(0)} MB` : "—"),
        perfRow("Documents held in memory", `${store.state.tabs.filter((t) => t.content !== undefined).length} of ${store.state.tabs.length} tabs`),
        perfRow("Suspended tabs", String(store.state.tabs.filter((t) => t.suspended).length)),
        perfRow("Chat entries retained", `${store.state.chat.length}`),
        perfRow("Terminal lines retained", String(store.state.terminals.reduce((n, t) => n + t.lines.length, 0))),
      ),
    ),
    group(
      "Indicator",
      null,
      toggle("Show the performance indicator in the status bar", "", s.showPerformanceIndicator, (v) => {
        save((st) => { st.settings!.showPerformanceIndicator = v; });
      }),
    ),
    group(
      "Help",
      "Ducky Coder Lite does not run a language server, so you will not see semantic type errors or cross-file diagnostics. That is a deliberate trade: a language server is typically 150–400 MB per language, which does not fit in a 2 GB budget alongside an editor and a browser engine.",
      h(
        "div",
        { class: "settings-callout" },
        icons.info(13),
        h(
          "span",
          null,
          "On a machine with more memory, run a language server in the terminal and pipe its diagnostics into a file — Ducky Coder Lite can then read them into the Problems panel.",
        ),
      ),
    ),
  ];
}

function perfRow(label: string, value: string): HTMLElement {
  return h("div", { class: "perf-row" }, h("span", { class: "perf-label" }, label), h("span", { class: "perf-value" }, value));
}
