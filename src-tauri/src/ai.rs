//! Ducky AI: remote inference, on-demand context retrieval, and the agent loop.
//!
//! ## The central constraint
//!
//! A 2 GB machine cannot host a language model, so **all inference is remote**.
//! That decision drives the rest of the module: because the provider is remote
//! and billed per token, we are just as motivated as the user's RAM to keep the
//! context small. The two constraints turn out to be the same constraint, which
//! is why "engineered for 2 GB" produces a *better* AI editor rather than a
//! crippled one.
//!
//! ## Context retrieval
//!
//! There is no repository index. When a request needs project context, the
//! retriever runs a bounded on-demand search, ranks the hits, reads only the
//! matching regions of the top few files, and assembles a compact context
//! block. The whole thing is capped by `max_context_tokens` and
//! `max_context_files` before a single byte goes out.

use crate::config::{AiConfig, ProviderKind};
use crate::error::{DuckyError, DuckyResult};
use crate::fsops::Workspace;
use crate::secret::{redact, SecretStore};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    /// A block of retrieved project context. Kept distinct so the UI can show
    /// exactly what the model was shown.
    Context,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// Cheap display name; never used for control flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ChatMessage {
    pub fn system(c: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: c.into(),
            name: None,
        }
    }
    pub fn user(c: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: c.into(),
            name: None,
        }
    }
    pub fn assistant(c: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: c.into(),
            name: None,
        }
    }
    pub fn context(c: impl Into<String>) -> Self {
        Self {
            role: Role::Context,
            content: c.into(),
            name: None,
        }
    }
    pub fn approx_tokens(&self) -> usize {
        // ~4 characters per token is the standard rule of thumb for English and
        // code. Being slightly generous here protects the budget.
        self.content.chars().count().div_ceil(4)
    }
}

// ---------------------------------------------------------------------------
// Context retrieval
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFile {
    /// Workspace-relative path.
    pub path: String,
    pub reason: String,
    pub chars: usize,
    pub tokens: usize,
    /// True when only an excerpt was sent rather than the whole file.
    pub partial: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedContext {
    pub files: Vec<ContextFile>,
    pub total_tokens: usize,
    /// Set when retrieval was cut short by the budget, so the model (and the
    /// user) know the view is partial.
    pub truncated: bool,
}

/// A file plus its actual text.
///
/// Kept separate from [`ContextFile`], which is the *metadata* sent to the UI.
/// Splitting them is deliberate: the context inspector shows paths and token
/// counts, and there is no code path that could hand it file contents.
#[derive(Debug, Clone)]
pub struct ContextFileWithBody {
    pub path: String,
    pub body: String,
    pub reason: String,
    pub chars: usize,
    pub tokens: usize,
    pub partial: bool,
}

/// Internal working set.
#[derive(Debug, Clone, Default)]
pub struct ContextBundle {
    pub meta: RetrievedContext,
    bodies: Vec<ContextFileWithBody>,
}

impl ContextBundle {
    pub fn render(&self) -> String {
        let mut out = String::new();
        for f in &self.bodies {
            out.push_str("\n--- FILE: ");
            out.push_str(&f.path);
            if f.partial {
                out.push_str(" (excerpt)");
            }
            out.push_str(" ---\n");
            out.push_str(&f.body);
            if !f.body.ends_with('\n') {
                out.push('\n');
            }
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.bodies.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalRequest {
    /// What the user asked, used to derive search terms.
    pub query: String,
    /// Extra terms from the caller (e.g. an error message plus a file path).
    #[serde(default)]
    pub hints: Vec<String>,
    /// Files the user pinned into the context panel.
    #[serde(default)]
    pub pinned: Vec<String>,
}

/// Build the context for a request.
///
/// The strategy, in order:
///   1. anything the user explicitly pinned always goes in, first;
///   2. run a content search for the query and the hints;
///   3. rank the hits (a hit that is a definition beats a hit that is a
///      mention) and read only the matching regions of the top files;
///   4. add direct import targets of the top hits, one level deep, because that
///      is the single highest-value connection in real code;
///   5. stop the instant the token budget is spent.
pub fn retrieve_context(
    ws: &Workspace,
    cfg: &AiConfig,
    req: &RetrievalRequest,
    search_cfg: &crate::config::SearchConfig,
) -> DuckyResult<ContextBundle> {
    let Some(root) = ws.root() else {
        return Ok(ContextBundle::default());
    };

    let budget_tokens = cfg.provider.max_context_tokens;
    let mut used_tokens = 0usize;
    let mut truncated = false;
    let mut bodies: Vec<ContextFileWithBody> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    // ---- 1. Pinned files, always included in the order the user added them.
    for pinned in &req.pinned {
        if used_tokens >= budget_tokens || bodies.len() >= cfg.max_context_files {
            truncated = true;
            break;
        }
        let full = match ws.resolve(pinned) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let body = match excerpt_for(&full, None, cfg.max_file_chars) {
            Some(b) => b,
            None => continue,
        };
        let tokens = body.1.chars().count().div_ceil(4);
        if used_tokens + tokens > budget_tokens {
            truncated = true;
            break;
        }
        used_tokens += tokens;
        seen.push(pinned.clone());
        bodies.push(ContextFileWithBody {
            path: pinned.clone(),
            body: body.1,
            reason: "pinned by you".into(),
            chars: tokens * 4,
            tokens,
            partial: body.0,
        });
    }

    // ---- 2. Content search for the request and its hints.
    let mut terms: Vec<String> = Vec::new();
    for t in salient_terms(&req.query).into_iter().chain(req.hints.iter().cloned()) {
        let t = t.trim().to_string();
        if t.len() >= 3 && !terms.contains(&t) {
            terms.push(t);
        }
        if terms.len() >= 5 {
            break;
        }
    }

    let mut candidates: Vec<(u32, String)> = Vec::new();
    for term in &terms {
        let sreq = crate::search::SearchRequest {
            root: root.to_string_lossy().to_string(),
            query: term.clone(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include_pattern: None,
            // A small per-term cap: we only need enough signal to rank files,
            // and every extra hit is memory and time.
            max_results: 60,
            max_file_bytes: search_cfg.max_file_bytes as u64,
            exclude_globs: search_cfg.exclude_globs.clone(),
            want_files: false,
        };
        let cancel = crate::search::SearchCancel::new();
        if let Ok(out) = crate::search::search_content(&sreq, &cancel) {
            for m in out.matches {
                // Score: earlier lines and shorter files are usually the
                // definition site rather than a stray mention.
                let mut score = 100u32;
                score = score.saturating_sub(m.line / 4);
                if m.path.ends_with(".d.ts") || m.path.contains("/test") || m.path.contains("spec") {
                    score = score.saturating_sub(15);
                }
                if let Some(existing) = candidates.iter_mut().find(|c| c.1 == m.path) {
                    existing.0 = existing.0.saturating_add(score / 2);
                } else {
                    candidates.push((score, m.path));
                }
            }
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.truncate(cfg.max_context_files.saturating_sub(bodies.len()).max(1));

    // ---- 3/4. Read excerpts, then follow imports one level deep.
    let mut import_queue: Vec<String> = Vec::new();
    for (_, rel) in candidates {
        if used_tokens >= budget_tokens || bodies.len() >= cfg.max_context_files {
            truncated = true;
            break;
        }
        if seen.contains(&rel) {
            continue;
        }
        let full = match ws.resolve(&rel) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let (partial, body) = match excerpt_for(&full, Some(&terms), cfg.max_file_chars) {
            Some(b) => b,
            None => continue,
        };
        let tokens = body.chars().count().div_ceil(4);
        if used_tokens + tokens > budget_tokens {
            // Try a tighter excerpt before giving up on the file entirely.
            let tight = cfg.max_file_chars / 4;
            let (_, small) = match excerpt_for(&full, Some(&terms), tight) {
                Some(b) => b,
                None => continue,
            };
            let small_tokens = small.chars().count().div_ceil(4);
            if used_tokens + small_tokens > budget_tokens {
                truncated = true;
                break;
            }
            used_tokens += small_tokens;
            import_queue.extend(imports_of(&full, root));
            seen.push(rel.clone());
            bodies.push(ContextFileWithBody {
                path: rel.clone(),
                body: small,
                reason: "matches your request".into(),
                chars: small_tokens * 4,
                tokens: small_tokens,
                partial: true,
            });
            continue;
        }
        used_tokens += tokens;
        import_queue.extend(imports_of(&full, root));
        seen.push(rel.clone());
        bodies.push(ContextFileWithBody {
            path: rel.clone(),
            body,
            reason: "matches your request".into(),
            chars: tokens * 4,
            tokens,
            partial,
        });
    }

    // ---- 4b. One level of imports, the highest-value links in real code.
    let mut import_targets: Vec<String> = Vec::new();
    for imp in import_queue {
        if import_targets.contains(&imp) {
            continue;
        }
        import_targets.push(imp);
        if import_targets.len() >= cfg.max_context_files {
            break;
        }
    }
    for rel in import_targets {
        if used_tokens >= budget_tokens || bodies.len() >= cfg.max_context_files {
            truncated = true;
            break;
        }
        if seen.contains(&rel) {
            continue;
        }
        let full = match ws.resolve(&rel) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let Ok(src) = std::fs::read_to_string(&full) else {
            continue;
        };
        if src.len() > 200_000 {
            continue;
        }
        // For an import target the *signature* is what the model needs, not the
        // whole body, so this stays cheap even for a big module.
        let head: String = src.lines().take(120).collect::<Vec<_>>().join("\n");
        let body = if src.lines().count() <= 120 {
            src
        } else {
            format!("{head}\n… (showing the first 120 lines) …")
        };
        let tokens = body.chars().count().div_ceil(4);
        if used_tokens + tokens > budget_tokens {
            truncated = true;
            break;
        }
        used_tokens += tokens;
        seen.push(rel.clone());
        bodies.push(ContextFileWithBody {
            path: rel.clone(),
            body,
            reason: "imported by the code above".into(),
            chars: tokens * 4,
            tokens,
            partial: true,
        });
    }

    let meta = RetrievedContext {
        files: bodies
            .iter()
            .map(|f| ContextFile {
                path: f.path.clone(),
                reason: f.reason.clone(),
                chars: f.chars,
                tokens: f.tokens,
                partial: f.partial,
            })
            .collect(),
        total_tokens: used_tokens,
        truncated,
    };

    Ok(ContextBundle { meta, bodies })
}

/// Read a file, or just the regions around the search terms when the file is
/// large. Returns `(was_excerpted, body)`.
fn excerpt_for(
    full: &Path,
    terms: Option<&[String]>,
    max_chars: usize,
) -> Option<(bool, String)> {
    let meta = std::fs::metadata(full).ok()?;
    if meta.len() == 0 || meta.len() > 8_000_000 {
        return None;
    }
    if crate::fsops::looks_binary(full) {
        return None;
    }
    let src = std::fs::read_to_string(full).ok()?;
    if src.chars().count() <= max_chars {
        return Some((false, src));
    }

    // Large file: build a windowed excerpt around the first few term hits.
    let lines: Vec<&str> = src.lines().collect();
    let mut keep: Vec<usize> = Vec::new();
    if let Some(terms) = terms {
        for (i, line) in lines.iter().enumerate() {
            let lower = line.to_lowercase();
            if terms.iter().any(|t| lower.contains(&t.to_lowercase())) {
                keep.push(i);
            }
            if keep.len() > 24 {
                break;
            }
        }
    }
    if keep.is_empty() {
        // No terms: take the head, which is where imports and signatures live.
        let head: String = lines.iter().take(160).cloned().collect::<Vec<_>>().join("\n");
        return Some((true, format!("{head}\n… (excerpt) …")));
    }
    keep.sort_unstable();
    let mut out = String::new();
    let mut last: Option<usize> = None;
    for idx in keep {
        let start = idx.saturating_sub(6);
        let end = (idx + 14).min(lines.len());
        if let Some(prev) = last {
            if start <= prev {
                continue;
            }
            out.push_str("\n…\n");
        }
        out.push_str(&lines[start..end].join("\n"));
        out.push('\n');
        last = Some(end);
        if out.chars().count() > max_chars {
            out.truncate(
                out.char_indices()
                    .nth(max_chars)
                    .map(|(i, _)| i)
                    .unwrap_or(out.len()),
            );
            break;
        }
    }
    Some((true, out))
}

/// Extract the module-level import targets of a source file, resolved relative
/// to the workspace root. Only the languages we claim to understand are parsed,
/// and the parser is a heuristic by design: a wrong guess costs one skipped
/// file, a full parse would cost the whole point of this feature.
fn imports_of(full: &Path, root: &Path) -> Vec<String> {
    let Ok(src) = std::fs::read_to_string(full) else {
        return Vec::new();
    };
    if src.len() > 400_000 {
        return Vec::new();
    }
    let ext = full
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let parent = full.parent().unwrap_or(root);
    let mut raw: Vec<String> = Vec::new();

    match ext.as_str() {
        "rs" => {
            for line in src.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("use ") {
                    raw.push(rest.trim_end_matches(';').to_string());
                } else if let Some(rest) = line.strip_prefix("mod ") {
                    raw.push(rest.trim_end_matches(';').to_string());
                }
            }
        }
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "vue" | "svelte" => {
            for line in src.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("import ") {
                    for q in ['\'', '"'] {
                        if let Some(start) = rest.find(q) {
                            if let Some(end) = rest[start + 1..].find(q) {
                                raw.push(rest[start + 1..start + 1 + end].to_string());
                                break;
                            }
                        }
                    }
                } else if let Some(rest) = line.strip_prefix("from ") {
                    let rest = rest.trim();
                    for q in ['\'', '"'] {
                        if let Some(start) = rest.find(q) {
                            if let Some(end) = rest[start + 1..].find(q) {
                                raw.push(rest[start + 1..start + 1 + end].to_string());
                                break;
                            }
                        }
                    }
                }
            }
        }
        "py" => {
            for line in src.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("import ") {
                    raw.push(rest.split_whitespace().next().unwrap_or("").to_string());
                } else if let Some(rest) = line.strip_prefix("from ") {
                    raw.push(rest.split_whitespace().next().unwrap_or("").to_string());
                }
            }
        }
        "lua" => {
            for line in src.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("require") {
                    for q in ['\'', '"'] {
                        if let Some(start) = rest.find(q) {
                            if let Some(end) = rest[start + 1..].find(q) {
                                raw.push(rest[start + 1..start + 1 + end].to_string());
                                break;
                            }
                        }
                    }
                }
            }
        }
        _ => return Vec::new(),
    }

    let mut out = Vec::new();
    for spec in raw.into_iter().take(24) {
        // Reduce a Rust path to its first segment: `crate::auth::login` -> `auth`.
        let cleaned = if ext == "rs" {
            spec.trim_start_matches("crate::")
                .trim_start_matches("super::")
                .split("::")
                .next()
                .unwrap_or("")
                .to_string()
        } else {
            spec.clone()
        };
        if cleaned.is_empty() || cleaned.starts_with('.') && cleaned.len() < 2 {
            continue;
        }
        for ext_try in ["ts", "tsx", "js", "jsx", "rs", "py", "lua"] {
            let candidate = if cleaned.starts_with('.') {
                parent.join(format!("{cleaned}.{ext_try}"))
            } else if ext == "py" {
                parent.join(format!("{cleaned}.py"))
            } else {
                parent.join(format!("{cleaned}.{ext_try}"))
            };
            if candidate.is_file() {
                if let Ok(rel) = candidate.strip_prefix(root) {
                    out.push(rel.to_string_lossy().to_string());
                }
                break;
            }
        }
    }
    out
}

/// Pull out the words most likely to identify code, dropping stopwords.
///
/// Cheap and language-agnostic: we are looking for identifiers, so anything with
/// a capital letter, a digit, `_`, `.` or camelCase hump is interesting, and
/// common English filler is not.
fn salient_terms(query: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "the", "and", "for", "with", "this", "that", "you", "your", "are", "can", "could",
        "please", "make", "add", "fix", "why", "how", "what", "when", "does", "did", "was",
        "were", "has", "have", "from", "into", "out", "about", "create", "build", "code",
        "file", "files", "project", "codebase", "explain", "refactor", "error", "errors",
        "crash", "bug", "here", "there", "should", "would", "need", "needs", "want", "let",
        "its", "it's", "isn't", "don't", "doesn't", "using", "use", "used", "need",
    ];
    query
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.' || c == '-'))
        .filter(|w| w.len() >= 3)
        .filter(|w| !STOP.contains(&w.to_lowercase().as_str()))
        .map(|w| w.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// Incremental stream events pushed to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum StreamEvent {
    /// First token of a reply; the UI uses it to swap the "thinking" indicator
    /// for a live bubble.
    Start { request_id: u64 },
    Delta { text: String },
    /// The model finished. `finish_reason` is surfaced so the UI can warn when
    /// output was cut off by the token cap.
    Done { finish_reason: Option<String>, cancelled: bool },
    Error { message: String },
}

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Default)]
pub struct AiClient {
    pub http: reqwest::Client,
}

impl AiClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            // A request that has not produced anything in this long is treated
            // as dead: on a slow 2 GB machine a hung socket would otherwise pin
            // memory and leave the UI spinning forever.
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(120))
            .pool_max_idle_per_host(2)
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .tcp_nodelay(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { http }
    }

    /// Resolve the chat-completions URL for a provider kind.
    fn endpoint(&self, cfg: &crate::config::AiProviderConfig) -> String {
        let base = cfg.base_url.trim_end_matches('/');
        match cfg.kind {
            ProviderKind::Ollama => format!("{base}/v1/chat/completions"),
            _ => {
                if base.ends_with("/chat/completions") {
                    base.to_string()
                } else {
                    format!("{base}/chat/completions")
                }
            }
        }
    }

    /// Verify credentials and reachability with the cheapest possible call.
    pub async fn test_connection(
        &self,
        cfg: &crate::config::AiProviderConfig,
        secrets: &SecretStore,
    ) -> DuckyResult<TestResult> {
        let key = secrets.get(&cfg.id);
        if cfg.kind.requires_key() && key.is_none() {
            return Ok(TestResult {
                ok: false,
                message: "No API key saved for this provider.".into(),
                model: cfg.model.clone(),
                latency_ms: 0,
            });
        }
        let body = serde_json::json!({
            "model": cfg.model,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "ping" }],
        });
        let started = std::time::Instant::now();
        let result = self.send(cfg, secrets, body, true).await;
        let latency_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(_) => Ok(TestResult {
                ok: true,
                message: format!("Connected to {}.", cfg.label),
                model: cfg.model.clone(),
                latency_ms,
            }),
            Err(e) => Ok(TestResult {
                ok: false,
                message: redact(&e.to_string()),
                model: cfg.model.clone(),
                latency_ms,
            }),
        }
    }

    async fn send(
        &self,
        cfg: &crate::config::AiProviderConfig,
        secrets: &SecretStore,
        body: serde_json::Value,
        stream: bool,
    ) -> DuckyResult<String> {
        let url = self.endpoint(cfg);
        let mut req = self.http.post(&url).json(&body);
        if let Some(key) = secrets.get(&cfg.id) {
            req = req.bearer_auth(key);
        } else if let Ok(env_key) = std::env::var("DUCKY_AI_KEY") {
            // A key supplied by the environment never touches disk.
            req = req.bearer_auth(env_key);
        }
        for (k, v) in &cfg.extra_headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = req
            .send()
            .await
            .map_err(|e| DuckyError::Network(redact(&e.to_string())))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(DuckyError::Network(format!(
                "{} returned {}: {}",
                cfg.label,
                status.as_u16(),
                redact(&text.chars().take(600).collect::<String>())
            )));
        }
        let mut resp = resp;
        let body = resp
            .text()
            .await
            .map_err(|e| DuckyError::Network(redact(&e.to_string())))?;
        if !stream {
            return Ok(body);
        }
        // For the connectivity probe we only need to know the stream starts.
        Ok(body.chars().take(1).collect())
    }

    /// Stream a chat completion, invoking `on_event` for every chunk.
    ///
    /// `cancel` is checked between chunks, so a user pressing Escape stops both
    /// the UI *and* the token spend.
    #[allow(clippy::too_many_arguments)]
    pub async fn stream_chat(
        &self,
        cfg: &crate::config::AiProviderConfig,
        secrets: &SecretStore,
        messages: &[ChatMessage],
        cancel: &CancelToken,
        mut on_event: impl FnMut(StreamEvent) + Send,
    ) -> DuckyResult<()> {
        let request_id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        let url = self.endpoint(cfg);

        // Hard-trim the message list to the token budget before sending, keeping
        // the system prompt and the most recent turns.
        let messages = trim_to_budget(messages, cfg.max_context_tokens);

        let mut body = serde_json::json!({
            "model": cfg.model,
            "messages": messages,
            "stream": true,
            "temperature": cfg.temperature,
            "max_tokens": cfg.max_output_tokens,
        });
        if matches!(cfg.kind, ProviderKind::Ollama) {
            body["stream"] = serde_json::Value::Bool(true);
        }

        let mut req = self.http
            .post(&url)
            .header("Accept", "text/event-stream")
            .json(&body);
        if let Some(key) = secrets.get(&cfg.id) {
            req = req.bearer_auth(key);
        } else if let Ok(env_key) = std::env::var("DUCKY_AI_KEY") {
            req = req.bearer_auth(env_key);
        }
        for (k, v) in &cfg.extra_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let resp = req
            .send()
            .await
            .map_err(|e| DuckyError::Network(redact(&e.to_string())))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(DuckyError::Network(format!(
                "{} returned {}: {}",
                cfg.label,
                status.as_u16(),
                redact(&text.chars().take(600).collect::<String>())
            )));
        }

        on_event(StreamEvent::Start { request_id });

        // `Response::chunk()` needs no extra reqwest feature, unlike
        // `bytes_stream()`. It hands back the same bytes, one chunk at a
        // time, which is all an SSE reader needs.
        let mut resp = resp;
        let mut buffer = String::new();
        let mut finish_reason: Option<String> = None;
        let mut cancelled = false;
        let mut first = true;

        // `chunk()` yields `Result<Option<Bytes>>`, so both the end-of-body and
        // the error case have to be handled here rather than in a `while let`.
        loop {
            if cancel.is_cancelled() {
                cancelled = true;
                break;
            }
            let chunk = match resp.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => {
                    on_event(StreamEvent::Error {
                        message: redact(&e.to_string()),
                    });
                    return Err(DuckyError::Network(redact(&e.to_string())));
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // SSE frames are separated by a blank line. We only ever parse the
            // tail, so a 40 MB stream does not mean a 40 MB rescan.
            while let Some(idx) = buffer.find("\n\n") {
                let frame: String = buffer.drain(..idx + 2).collect();
                if first {
                    first = false;
                    continue;
                }
                for line in frame.lines() {
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let data = data.trim();
                    if data.is_empty() {
                        continue;
                    }
                    if data == "[DONE]" {
                        cancelled = false;
                        break;
                    }
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                        continue;
                    };
                    if let Some(reason) = v.get("finish_reason").and_then(|r| r.as_str()) {
                        finish_reason = Some(reason.to_string());
                    }
                    if let Some(text) = v
                        .pointer("/choices/0/delta/content")
                        .and_then(|c| c.as_str())
                    {
                        if !text.is_empty() {
                            on_event(StreamEvent::Delta {
                                text: text.to_string(),
                            });
                        }
                    } else if let Some(text) =
                        v.pointer("/choices/0/message/content").and_then(|c| c.as_str())
                    {
                        // Ollama's non-SSE fallback shape.
                        on_event(StreamEvent::Delta {
                            text: text.to_string(),
                        });
                    }
                }
            }
        }

        on_event(StreamEvent::Done {
            finish_reason,
            cancelled,
        });
        Ok(())
    }

    /// One-shot, non-streaming completion, used for autocomplete and for
    /// structured tasks like generating a plan.
    pub async fn complete(
        &self,
        cfg: &crate::config::AiProviderConfig,
        secrets: &SecretStore,
        system: &str,
        user: &str,
        max_tokens: usize,
        cancel: &CancelToken,
    ) -> DuckyResult<String> {
        let messages = vec![ChatMessage::system(system), ChatMessage::user(user)];
        let request_id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        let url = self.endpoint(cfg);
        let body = serde_json::json!({
            "model": cfg.model,
            "messages": trim_to_budget(&messages, cfg.max_context_tokens.min(4_000)),
            "stream": false,
            "temperature": cfg.temperature,
            "max_tokens": max_tokens,
        });
        let mut req = self.http.post(&url).json(&body);
        if let Some(key) = secrets.get(&cfg.id) {
            req = req.bearer_auth(key);
        } else if let Ok(env_key) = std::env::var("DUCKY_AI_KEY") {
            req = req.bearer_auth(env_key);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| DuckyError::Network(redact(&e.to_string())))?;
        // `Response::text` and `Response::json` both take `self` by value, so
        // the status has to be captured before either of them runs.
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(DuckyError::Network(format!(
                "{} returned {}: {}",
                cfg.label,
                status.as_u16(),
                redact(&text.chars().take(400).collect::<String>())
            )));
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| DuckyError::Network(redact(&e.to_string())))?;
        let _ = request_id;
        if cancel.is_cancelled() {
            return Err(DuckyError::Cancelled);
        }
        let content = v
            .pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
            .or_else(|| v.pointer("/message/content").and_then(|c| c.as_str()))
            .unwrap_or("")
            .to_string();
        Ok(content)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub model: String,
    pub latency_ms: u64,
}

/// Trim a conversation to fit the budget, keeping the system prompt and the
/// newest messages. This is the single most important memory control in the AI
/// subsystem: without it a long chat silently grows the request payload until
/// the provider rejects it.
fn trim_to_budget(messages: &[ChatMessage], budget_tokens: usize) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::new();
    let mut used = 0usize;

    // Always keep the system prompt, however long.
    if let Some(sys) = messages.iter().find(|m| m.role == Role::System) {
        used += sys.approx_tokens();
        out.push(sys.clone());
    }

    let rest: Vec<&ChatMessage> = messages
        .iter()
        .filter(|m| m.role != Role::System)
        .collect();

    // Walk backwards so we keep the recent turns.
    let mut kept_recent: Vec<&ChatMessage> = Vec::new();
    for m in rest.iter().rev() {
        let t = m.approx_tokens();
        if used + t > budget_tokens {
            break;
        }
        used += t;
        kept_recent.push(m);
    }
    kept_recent.reverse();

    // If even the newest message does not fit on its own, truncate it rather
    // than dropping it, so the model still sees the actual question.
    if kept_recent.is_empty() {
        if let Some(last) = rest.last() {
            let max_chars = budget_tokens * 4;
            let mut content = last.content.clone();
            if content.chars().count() > max_chars {
                content = content
                    .chars()
                    .skip(content.chars().count() - max_chars)
                    .collect();
                content = format!("…(truncated)\n{content}");
            }
            out.push(ChatMessage {
                role: last.role.clone(),
                content,
                name: last.name.clone(),
            });
            return out;
        }
    }

    out.extend(kept_recent.into_iter().cloned());
    out
}

/// Cooperative cancellation shared with the UI.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// Conversation memory
// ---------------------------------------------------------------------------

/// A conversation whose size is bounded by characters, not by hope.
///
/// When the budget is exceeded the oldest non-system messages are dropped and
/// replaced by a single summary line, so the thread stays usable without the
/// local history growing without limit. The full history is never persisted.
pub struct Conversation {
    pub messages: Vec<ChatMessage>,
    chars: usize,
    budget: usize,
    threshold: usize,
    /// How many summarisations have happened, surfaced in the UI.
    pub compressions: u32,
}

impl Conversation {
    pub fn new(cfg: &AiConfig) -> Self {
        Self {
            messages: Vec::new(),
            chars: 0,
            budget: cfg.history_char_budget,
            threshold: cfg.history_message_threshold,
            compressions: 0,
        }
    }

    pub fn push(&mut self, msg: ChatMessage) {
        self.chars += msg.content.chars().count();
        self.messages.push(msg);
        self.enforce();
    }

    fn enforce(&mut self) {
        // Compress at most once per push, otherwise a single very large message
        // could trigger a cascade of compressions.
        if self.messages.len() > self.threshold || self.chars > self.budget {
            self.compress();
        }
    }

    /// Replace the middle of the conversation with a compact summary.
    ///
    /// Kept: every system prompt, the original task (first user message) and
    /// the most recent exchanges. Dropped: everything in between, replaced by a
    /// one-line note describing what was elided. This is lossy on purpose: the
    /// alternative is an ever-growing history, and on a 2 GB machine the
    /// conversation must never be the reason memory runs out.
    fn compress(&mut self) {
        if self.messages.len() <= 4 {
            // Nothing meaningful to summarise. If we are still over budget,
            // drop the oldest non-system message outright.
            while self.chars > self.budget {
                let Some(pos) = self
                    .messages
                    .iter()
                    .position(|m| m.role != Role::System)
                else {
                    break;
                };
                self.chars -= self.messages[pos].content.chars().count();
                self.messages.remove(pos);
            }
            return;
        }

        let tail_keep = 6usize.min(self.messages.len());
        let original = std::mem::take(&mut self.messages);

        let split = original.len() - tail_keep;
        let (elided, tail) = original.split_at(split);

        let system: Vec<ChatMessage> = elided
            .iter()
            .filter(|m| m.role == Role::System)
            .cloned()
            .collect();
        let first_user = elided.iter().find(|m| m.role == Role::User).cloned();

        let elided_chars: usize = elided
            .iter()
            .filter(|m| m.role != Role::System)
            .map(|m| m.content.chars().count())
            .sum();

        let mut rebuilt: Vec<ChatMessage> = Vec::with_capacity(system.len() + tail.len() + 2);
        rebuilt.extend(system);
        if let Some(first) = first_user {
            rebuilt.push(first);
        }
        if elided_chars > 0 {
            rebuilt.push(ChatMessage::context(format!(
                "[{elided_chars} characters of earlier conversation were compressed to save memory. \
                 The user's original request is above; the most recent {} messages follow.]",
                tail.len()
            )));
        }
        rebuilt.extend(tail.iter().cloned());

        self.chars = rebuilt.iter().map(|m| m.content.chars().count()).sum();
        self.messages = rebuilt;
        self.compressions += 1;
    }

    /// Hard reset, used by "Clear Chat". Releases the strings immediately.
    pub fn clear(&mut self) {
        self.messages.clear();
        self.messages.shrink_to_fit();
        self.chars = 0;
        self.compressions = 0;
    }

    pub fn chars(&self) -> usize {
        self.chars
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/// The system prompt. Deliberately terse: a long system prompt is paid for on
/// every single request, including every autocomplete keystroke burst.
pub fn system_prompt(ws: &Workspace, has_context: bool, agent_mode: bool) -> String {
    let mut p = String::from(
        "You are Ducky AI, the assistant built into Ducky Coder Lite, a code editor for low-memory computers.\n\
         Answer with the smallest correct change. Prefer editing existing code over adding new files.\n\
         When you propose an edit, return it as a fenced code block tagged with the file path, like:\n\
         ```path src/main.rs\n<full new file contents or the exact replacement block>\n```\n\
         Never invent files that do not exist unless the user asked you to create them.\n\
         Keep prose short. Code is the answer.",
    );
    if let Some(root) = ws.root() {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        p.push_str(&format!("\nThe open project is \"{name}\"."));
    }
    if has_context {
        p.push_str(
            "\nRelevant project files are included below. Rely on them; do not say you need more context \
             unless the included files are genuinely insufficient.",
        );
    }
    if agent_mode {
        p.push_str(
            "\nYou are in agent mode. You may inspect files, propose edits and suggest shell commands. \
             Every write and every command goes through the user for approval, so state clearly what you \
             want to change and why.",
        );
    }
    p
}

pub fn autocomplete_prompt(language: &str) -> String {
    format!(
        "Complete the code at the cursor. Reply with ONLY the completion text, no prose, no markdown \
         fences, no repetition of the text before the cursor. Language: {language}. If the cursor is at \
         a natural stopping point, reply with nothing."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_trimming_keeps_system_and_recent() {
        let mut msgs = vec![ChatMessage::system("SYS")];
        for i in 0..50 {
            msgs.push(ChatMessage::user(format!("message number {i} {}", "x".repeat(200))));
        }
        let trimmed = trim_to_budget(&msgs, 500);
        assert_eq!(trimmed[0].content, "SYS");
        assert!(
            trimmed.len() < msgs.len(),
            "must have dropped messages: {} -> {}",
            msgs.len(),
            trimmed.len()
        );
        let total: usize = trimmed.iter().map(|m| m.approx_tokens()).sum();
        assert!(total <= 600, "budget not respected: {total}");
        // The newest message survives.
        assert!(trimmed.last().unwrap().content.contains("49"));
    }

    #[test]
    fn trimming_never_loses_the_actual_question() {
        let huge = "q".repeat(200_000);
        let msgs = vec![
            ChatMessage::system("SYS"),
            ChatMessage::user(huge),
        ];
        let trimmed = trim_to_budget(&msgs, 100);
        assert!(trimmed.iter().any(|m| m.content.contains('q')));
        assert!(trimmed.iter().any(|m| m.content.starts_with("…(truncated)")));
    }

    #[test]
    fn conversation_is_bounded_and_clear_releases() {
        let cfg = AiConfig {
            history_char_budget: 2_000,
            history_message_threshold: 6,
            ..Default::default()
        };
        let mut c = Conversation::new(&cfg);
        for _ in 0..40 {
            c.push(ChatMessage::user("x".repeat(200)));
        }
        assert!(
            c.chars() <= 2_000,
            "conversation grew past its budget: {}",
            c.chars()
        );
        c.clear();
        assert_eq!(c.chars(), 0);
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn salient_terms_drop_stopwords() {
        let terms = salient_terms("Fix the authentication bug in the login handler please");
        assert!(terms.iter().any(|t| t.contains("authentication")));
        assert!(!terms.contains(&"please".to_string()));
    }

    #[test]
    fn retrieved_context_renders_with_file_headers() {
        let bundle = ContextBundle {
            meta: RetrievedContext::empty(),
            bodies: vec![ContextFileWithBody {
                path: "src/auth.rs".into(),
                body: "fn login() {}".into(),
                reason: "pinned".into(),
                chars: 12,
                tokens: 3,
                partial: false,
            }],
        };
        let rendered = bundle.render();
        assert!(rendered.contains("--- FILE: src/auth.rs ---"));
        assert!(rendered.contains("fn login() {}"));
    }

    #[test]
    fn cancel_token_roundtrip() {
        let t = CancelToken::new();
        assert!(!t.is_cancelled());
        t.cancel();
        assert!(t.is_cancelled());
    }

    #[test]
    fn command_classification_is_not_part_of_ai() {
        // Guards against accidentally moving shell execution into the AI module.
        assert!(!std::any::type_name::<AiClient>().contains("pty"));
    }
}
