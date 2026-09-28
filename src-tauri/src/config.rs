//! Persisted user settings.
//!
//! The whole config is a single small JSON document. There is no migration
//! framework and no database, because a config that takes 40 MB to load is a
//! config that will make a 2 GB machine stutter on startup.

use crate::error::{DuckyError, DuckyResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// AI provider kinds we know how to talk to. All of them speak the
/// OpenAI-style `/chat/completions` dialect except `ollama`, which uses
/// `/api/chat` with a very similar body — close enough that one code path with
/// a path/field adapter beats three near-duplicate clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// Ducky AI's hosted endpoint.
    Ducky,
    /// Any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, Together,
    /// Azure-shaped gateways, LM Studio, vLLM...
    OpenAiCompatible,
    /// Ollama (and Ollama-shaped gateways).
    Ollama,
    /// A plain local OpenAI-compatible server, e.g. llama.cpp's server.
    LocalServer,
}

impl ProviderKind {
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Ducky => "https://api.duckycoder.ai/v1",
            Self::OpenAiCompatible => "https://api.openai.com/v1",
            Self::Ollama => "http://127.0.0.1:11434",
            Self::LocalServer => "http://127.0.0.1:1234/v1",
        }
    }

    /// Whether this provider needs a credential to be useful.
    pub fn requires_key(self) -> bool {
        matches!(self, Self::Ducky | Self::OpenAiCompatible)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String,
    pub label: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
    /// Small/fast model used for autocomplete and lightweight refactors.
    pub fast_model: String,
    pub has_key: bool,
    /// Hard cap on tokens sent per request. This is the single most important
    /// knob in the app: it is what stops a huge repository context from
    /// blowing up both the provider bill and our own memory.
    pub max_context_tokens: usize,
    /// Max tokens we are willing to render back.
    pub max_output_tokens: usize,
    pub temperature: f32,
    /// Extra headers for gateways that need them (kept separate from the key).
    pub extra_headers: BTreeMapLike,
}

pub type BTreeMapLike = std::collections::BTreeMap<String, String>;

impl Default for AiProviderConfig {
    fn default() -> Self {
        Self {
            id: "ducky".into(),
            label: "Ducky AI".into(),
            kind: ProviderKind::Ducky,
            base_url: ProviderKind::Ducky.default_base_url().into(),
            model: "ducky-coder".into(),
            fast_model: "ducky-coder-fast".into(),
            has_key: false,
            max_context_tokens: 24_000,
            max_output_tokens: 4_096,
            temperature: 0.2,
            extra_headers: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConfig {
    pub shell: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Hard cap on retained scrollback, in lines. Terminal buffers are the
    /// single easiest way to leak hundreds of megabytes in a long build.
    pub scrollback_lines: usize,
    pub font_size: u16,
    pub cursor_blink: bool,
    pub copy_on_select: bool,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        let (shell, args) = default_shell();
        Self {
            shell,
            args,
            cwd: String::new(),
            scrollback_lines: 750,
            font_size: 13,
            cursor_blink: true,
            copy_on_select: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfig {
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub tab_size: usize,
    pub insert_spaces: bool,
    pub word_wrap: bool,
    pub minimap: bool,
    pub line_numbers: bool,
    pub bracket_matching: bool,
    pub format_on_save: bool,
    /// Files above this size (bytes) get reduced analysis, folding and
    /// AI-context treatment.
    pub large_file_bytes: usize,
    /// Files above this size are refused from the editor's rich features
    /// entirely and shown in a degraded read-only-ish mode.
    pub huge_file_bytes: usize,
    pub render_line_limit: usize,
    pub bracket_pair_colorization: bool,
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            font_family: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace".into(),
            font_size: 13,
            line_height: 1.55,
            tab_size: 4,
            insert_spaces: true,
            word_wrap: false,
            minimap: false,
            line_numbers: true,
            bracket_matching: true,
            format_on_save: false,
            large_file_bytes: 1_500_000,
            huge_file_bytes: 8_000_000,
            render_line_limit: 20_000,
            bracket_pair_colorization: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: AiProviderConfig,
    /// Send the surrounding function/scope with a request automatically.
    pub auto_context: bool,
    /// Max files the retriever may pull in for a single turn.
    pub max_context_files: usize,
    /// Max characters of any single file handed to the model.
    pub max_file_chars: usize,
    /// Debounce before firing an autocomplete request, in ms.
    pub autocomplete_debounce_ms: u32,
    pub autocomplete_enabled: bool,
    /// Agent may propose edits but never writes without approval.
    pub agent_requires_approval: bool,
    /// Agent may run shell commands, but never without an explicit prompt.
    pub agent_can_run_commands: bool,
    /// Cap on characters kept locally per conversation before compressing.
    pub history_char_budget: usize,
    /// Compress the conversation once it exceeds this many messages.
    pub history_message_threshold: usize,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: AiProviderConfig::default(),
            auto_context: true,
            max_context_files: 8,
            max_file_chars: 24_000,
            autocomplete_debounce_ms: 350,
            autocomplete_enabled: true,
            agent_requires_approval: true,
            agent_can_run_commands: true,
            history_char_budget: 120_000,
            history_message_threshold: 24,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfig {
    pub exclude_globs: Vec<String>,
    pub max_results: usize,
    pub max_file_bytes: usize,
    pub case_sensitive: bool,
    pub use_regex: bool,
    pub whole_word: bool,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            exclude_globs: vec![
                "**/node_modules/**".into(),
                "**/.git/**".into(),
                "**/dist/**".into(),
                "**/build/**".into(),
                "**/target/**".into(),
                "**/bin/**".into(),
                "**/obj/**".into(),
                "**/.venv/**".into(),
                "**/__pycache__/**".into(),
                "**/.next/**".into(),
                "**/.cache/**".into(),
                "**/vendor/**".into(),
                "**/coverage/**".into(),
            ],
            max_results: 2_000,
            // Binary-ish and generated artefacts are skipped past this size so a
            // stray 80 MB bundle cannot stall a search.
            max_file_bytes: 2_000_000,
            case_sensitive: false,
            use_regex: false,
            whole_word: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LowMemoryConfig {
    pub enabled: bool,
    /// When the whole machine drops below this much free RAM (in MB) we start
    /// shedding load. ~256 MB leaves enough headroom to keep editing.
    pub shed_threshold_mb: u32,
    /// Critical level: suspend everything non-active and pause background work.
    pub critical_threshold_mb: u32,
    pub suspend_inactive_tabs: bool,
    /// Tabs kept warm in the document cache before suspension begins.
    pub warm_tab_limit: usize,
    /// Max lines CodeMirror is allowed to render/measure.
    pub max_render_lines: usize,
    pub suspend_language_services: bool,
    pub pause_background_indexing: bool,
    pub max_search_results: usize,
    pub terminal_scrollback: usize,
    pub show_notice: bool,
}

impl Default for LowMemoryConfig {
    fn default() -> Self {
        Self {
            // On by default: the whole premise of the product.
            enabled: true,
            shed_threshold_mb: 256,
            critical_threshold_mb: 128,
            suspend_inactive_tabs: true,
            warm_tab_limit: 3,
            max_render_lines: 12_000,
            suspend_language_services: true,
            pause_background_indexing: true,
            max_search_results: 500,
            terminal_scrollback: 300,
            show_notice: true,
        }
    }
}

/// The persisted settings document.
///
/// `default` is **not** a deny-by-default: a settings file written by an older
/// build must still load, with any newly added field taking its default. A new
/// field without `#[serde(default)]` would make every existing config
/// unparseable, which would silently reset a user's preferences.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "version")]
    pub version: u32,
    #[serde(default)]
    pub last_workspace: Option<String>,
    #[serde(default)]
    pub recent_workspaces: Vec<RecentWorkspace>,
    #[serde(default)]
    pub editor: EditorConfig,
    #[serde(default)]
    pub ai: AiConfig,
    #[serde(default)]
    pub terminal: TerminalConfig,
    #[serde(default)]
    pub search: SearchConfig,
    #[serde(default)]
    pub low_memory: LowMemoryConfig,
    #[serde(default = "yes")]
    pub show_performance_indicator: bool,
    #[serde(default = "yes")]
    pub telemetry: bool,
    /// The file storage is allowed to touch. Anything outside is refused by
    /// `fsops`, which is a real security boundary, not a suggestion.
    #[serde(default)]
    pub open_recent: bool,
}

fn version() -> u32 {
    1
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub path: String,
    pub name: String,
    pub last_opened: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: version(),
            last_workspace: None,
            recent_workspaces: Vec::new(),
            editor: EditorConfig::default(),
            ai: AiConfig::default(),
            terminal: TerminalConfig::default(),
            search: SearchConfig::default(),
            low_memory: LowMemoryConfig::default(),
            show_performance_indicator: true,
            telemetry: false,
            open_recent: true,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    inner: parking_lot::RwLock<Settings>,
}

impl SettingsStore {
    pub fn load(dir: &PathBuf) -> DuckyResult<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|e| DuckyError::Config(format!("cannot create config dir: {e}")))?;
        let path = dir.join("settings.json");
        let mut settings = Settings::default();
        if let Ok(text) = std::fs::read_to_string(&path) {
            match serde_json::from_str::<Settings>(&text) {
                Ok(parsed) => settings = parsed,
                Err(e) => {
                    // A corrupt config must never stop the editor from starting.
                    // Keep a copy so the user can recover their settings, then
                    // continue with defaults.
                    let backup = dir.join("settings.corrupt.json");
                    let _ = std::fs::rename(&path, backup);
                    eprintln!("[ducky] settings.json was unreadable ({e}); using defaults");
                }
            }
        }
        Ok(Self {
            path,
            inner: parking_lot::RwLock::new(settings),
        })
    }

    pub fn get(&self) -> Settings {
        self.inner.read().clone()
    }

    /// Replace the whole document and return what was actually saved, so a
    /// command can hand the result straight back to the UI.
    pub fn replace(&self, next: Settings) -> DuckyResult<Settings> {
        {
            let mut guard = self.inner.write();
            *guard = next;
        }
        self.persist()?;
        Ok(self.get())
    }

    pub fn update<F: FnOnce(&mut Settings)>(&self, f: F) -> DuckyResult<Settings> {
        let next = {
            let mut guard = self.inner.write();
            f(&mut guard);
            guard.clone()
        };
        self.persist()?;
        Ok(next)
    }

    fn persist(&self) -> DuckyResult<()> {
        let guard = self.inner.read();
        let json = serde_json::to_vec_pretty(&*guard)?;
        drop(guard);
        // Atomic replace so a crash mid-write cannot corrupt the config.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)
            .map_err(|e| DuckyError::Config(format!("cannot write settings: {e}")))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| DuckyError::Config(format!("cannot save settings: {e}")))?;
        Ok(())
    }

    pub fn note_workspace(&self, path: &str) {
        let name = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = self.update(|s| {
            s.last_workspace = Some(path.to_string());
            s.recent_workspaces.retain(|w| w.path != path);
            s.recent_workspaces.insert(
                0,
                RecentWorkspace {
                    path: path.to_string(),
                    name,
                    last_opened: now,
                },
            );
            // A bounded list: recents are a convenience, not an archive.
            s.recent_workspaces.truncate(12);
        });
    }
}

/// Pick a sensible shell for the host platform.
pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        (comspec, vec!["/K".into(), "title Ducky Coder Lite".into()])
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Honour the user's own SHELL; fall back through the usual suspects.
        if let Ok(sh) = std::env::var("SHELL") {
            if !sh.is_empty() && std::path::Path::new(&sh).exists() {
                return (sh, vec!["-l".into()]);
            }
        }
        for candidate in ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/sh"] {
            if std::path::Path::new(candidate).exists() {
                return (candidate.to_string(), if candidate.ends_with("sh") && !candidate.ends_with("bash") { vec![] } else { vec!["-l".into()] });
            }
        }
        ("/bin/sh".to_string(), vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_low_memory_oriented() {
        let s = Settings::default();
        assert!(s.low_memory.enabled, "low memory mode must be on by default");
        assert!(!s.editor.minimap, "minimap must be off by default");
        assert!(
            s.terminal.scrollback_lines <= 1000,
            "terminal scrollback must be bounded"
        );
        assert!(s.search.exclude_globs.iter().any(|g| g.contains("node_modules")));
    }

    #[test]
    fn settings_roundtrip_without_loss() {
        let dir = std::env::temp_dir().join(format!("ducky-settings-{}-{:?}",
            std::process::id(),
            std::thread::current().id(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = SettingsStore::load(&dir).unwrap();
        store
            .update(|s| {
                s.editor.tab_size = 2;
                s.ai.provider.model = "some-model".into();
            })
            .unwrap();
        let store2 = SettingsStore::load(&dir).unwrap();
        let got = store2.get();
        assert_eq!(got.editor.tab_size, 2);
        assert_eq!(got.ai.provider.model, "some-model");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_settings_fall_back_to_defaults() {
        let dir = std::env::temp_dir().join(format!(
            "ducky-bad-{}-{:?}",
            std::process::id(),
            std::thread::current().id(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), "{not json at all").unwrap();
        let store = SettingsStore::load(&dir).unwrap();
        assert_eq!(store.get().version, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
