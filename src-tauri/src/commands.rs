//! Every command the frontend can invoke.
//!
//! Three rules are followed throughout this file, and they are the reason the
//! app stays responsive on a 2 GB machine:
//!
//! 1. **Nothing blocking runs on the UI thread.** Tauri executes a synchronous
//!    `#[tauri::command]` on the main thread, so any command that touches the
//!    disk or spawns a process is declared `async` and moves the work into
//!    `spawn_blocking`. Without this, walking a project would freeze the
//!    window.
//! 2. **No lock guard is held across an `await`.** A `parking_lot` guard is not
//!    `Send`, and Tauri requires command futures to be `Send`. Guards are
//!    scoped into a block that provably ends before the first suspension.
//! 3. **Secrets never cross the boundary.** API keys are written to the store
//!    and read back only inside `ai.rs`; `secret_status` reports a boolean per
//!    provider, and command output goes through the same redactor so a shell
//!    cannot echo a key back into the UI.

use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri::Emitter;

use crate::ai::{self, CancelToken, ChatMessage, StreamEvent};
use crate::config::{AiProviderConfig, Settings};
use crate::error::{DuckyError, DuckyResult};
use crate::fsops::{self, EntryKind};
use crate::git;
use crate::meminfo;
use crate::pty::{self, CommandResult, PtyData, PtyEmitter, PtyExit};
use crate::search::{self, SearchCancel};
use crate::state::{self, AppState, Pressure};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// The open workspace root, or a clear error if nothing is open.
///
/// Every filesystem and git command starts here. Doing the check in one place
/// means a command can never accidentally operate on a path outside the
/// project, even if the frontend sends something unexpected.
fn root_or_err(state: &State<'_, Arc<AppState>>) -> DuckyResult<std::path::PathBuf> {
    state
        .workspace
        .read()
        .root()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| DuckyError::InvalidPath("no folder is open".into()))
}

/// Line endings actually used in a file, so the editor can preserve them.
fn detect_eol(path: &std::path::Path) -> &'static str {
    // A short prefix scan is enough: mixing line endings inside one file is
    // vanishingly rare, and the first line is a good bet for all of them.
    use std::io::Read;
    let mut buf = [0u8; 8192];
    let Ok(mut f) = std::fs::File::open(path) else {
        return "lf";
    };
    let Ok(n) = f.read(&mut buf) else {
        return "lf";
    };
    for w in buf[..n].windows(2) {
        if w == b"\r\n" {
            return "crlf";
        }
    }
    "lf"
}

/// Read a file for the editor, on a blocking thread, with a hard byte cap.
///
/// Returns `None` when the file turned out to be binary: the editor cannot show
/// it, and a hex dump of a 2 MB blob is not a useful substitute.
fn read_for_editor(path: &std::path::Path, max_bytes: u64) -> DuckyResult<Option<String>> {
    if fsops::looks_binary(path) {
        return Ok(None);
    }
    let (text, _truncated) = fsops::read_file(path, max_bytes)?;
    Ok(Some(text))
}

/// Trim a long string for an error message, keeping both ends.
///
/// Error text is surfaced in a toast, so the useful parts are the start (what
/// was attempted) and the end (where it actually failed).
fn trim_to(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let half = max / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(text.chars().count() - half).collect();
    format!("{head}\n… {half} characters omitted …\n{tail}")
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn app_info(state: State<'_, Arc<AppState>>) -> serde_json::Value {
    let settings = state.settings.get();
    let secrets = state.secrets.status();
    serde_json::json!({
        "name": "Ducky Coder Lite",
        "tagline": "Code fast. Stay light.",
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeSeconds": state.uptime_secs(),
        "gitAvailable": git::available(),
        "shells": pty::available_shells(),
        "lastWorkspace": settings.last_workspace,
        "recentWorkspaces": settings.recent_workspaces,
        "secrets": secrets,
        "pressure": state.pressure(),
    })
}

/// Take a reading and re-evaluate the pressure ladder from it.
///
/// The ladder is recomputed from the *same* snapshot the UI is shown, so the
/// "LOW MEMORY" label and the numbers beside it can never disagree.
fn take_snapshot(state: &AppState) -> meminfo::MemSnapshot {
    let snap = meminfo::snapshot();
    let lm = state.settings.get().low_memory;
    let next = state::evaluate_pressure(
        &snap,
        state.pressure(),
        lm.enabled,
        lm.shed_threshold_mb,
        lm.critical_threshold_mb,
    );
    state.set_pressure(next);
    snap
}

#[tauri::command]
pub fn mem_snapshot(state: State<'_, Arc<AppState>>) -> meminfo::MemSnapshot {
    take_snapshot(&state)
}

// ---------------------------------------------------------------------------
// Settings and secrets
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    state.settings.get()
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> DuckyResult<Settings> {
    state.settings.replace(settings)
}

#[tauri::command]
pub fn set_secret(
    state: State<'_, Arc<AppState>>,
    provider: String,
    key: String,
) -> DuckyResult<()> {
    state.secrets.set(&provider, &key)?;
    // Keep the settings' "has a key" flag in step, so the UI reflects reality
    // without a second round trip.
    let id = provider.clone();
    state.settings.update(|s| {
        if s.ai.provider.id == id {
            s.ai.provider.has_key = !key.trim().is_empty();
        }
    })?;
    Ok(())
}

#[tauri::command]
pub fn clear_secret(state: State<'_, Arc<AppState>>, provider: String) -> DuckyResult<()> {
    state.secrets.clear(&provider)?;
    let id = provider.clone();
    state.settings.update(|s| {
        if s.ai.provider.id == id {
            s.ai.provider.has_key = false;
        }
    })?;
    Ok(())
}

#[tauri::command]
pub fn secret_status(state: State<'_, Arc<AppState>>) -> crate::secret::SecretStatus {
    state.secrets.status()
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_folder(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    path: String,
) -> DuckyResult<serde_json::Value> {
    {
        let mut ws = state.workspace.write();
        ws.open(std::path::Path::new(&path))?;
    }
    let root = state.workspace.read().root_str().unwrap_or_default();
    state.settings.note_workspace(&root);
    let entries = fsops::list_dir(&state.workspace.read(), "")?;
    let settings = state.settings.get();
    // A new project changes what "low memory" means, so re-evaluate at once.
    emit_mem_snapshot(&app, &state);
    Ok(serde_json::json!({
        "root": root,
        "name": std::path::Path::new(&root)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.clone()),
        "entries": entries,
        "settings": settings,
    }))
}

#[tauri::command]
pub fn close_folder(state: State<'_, Arc<AppState>>) {
    state.workspace.write().close();
    state.settings.update(|s| s.last_workspace = None).ok();
}

#[tauri::command]
pub fn list_dir(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> DuckyResult<Vec<fsops::FsEntry>> {
    fsops::list_dir(&state.workspace.read(), &path)
}

#[tauri::command]
pub async fn read_file(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> DuckyResult<serde_json::Value> {
    // A nested scope, not an explicit `drop`: the compiler still counts a
    // guard's destructor as a use, so the guard has to end *lexically* before
    // the await or the whole future stops being `Send`.
    let (full, settings) = {
        let ws = state.workspace.read();
        (ws.resolve(&path)?, state.settings.get())
    };

    let meta = std::fs::metadata(&full).map_err(DuckyError::from)?;
    let md = meta;
    let large = settings.editor.large_file_bytes;
    let huge = settings.editor.huge_file_bytes;

    // Over the "huge" threshold we refuse to open the file in the editor at
    // all, because even a capped read of an 8 MB+ file is a poor trade on a
    // 2 GB machine. The user gets a clear message instead of a stall.
    if md.len() as usize > huge {
        return Ok(serde_json::json!({
            "path": full.to_string_lossy(),
            "refused": true,
            "size": md.len(),
            "message": format!(
                "This file is {:.1} MB. Ducky Coder Lite limits analysis for files this large to \
                 keep memory usage down, so it will not open it in the editor.",
                md.len() as f64 / (1024.0 * 1024.0)
            ),
        }));
    }

    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let language = fsops::language_for(&name);

    let for_read = full.clone();
    let outcome = tokio::task::spawn_blocking(move || read_for_editor(&for_read, large as u64))
        .await
        .map_err(|e| DuckyError::Io(format!("read task failed: {e}")))??;

    let eol = detect_eol(&full);
    let is_large = md.len() as usize > large as usize;

    match outcome {
        None => Ok(serde_json::json!({
            "path": full.to_string_lossy(),
            "binary": true,
            "size": md.len(),
            "language": language,
            "message": "This looks like a binary file, so it is not shown in the editor.",
            "eol": eol,
        })),
        Some(content) => Ok(serde_json::json!({
            "path": full.to_string_lossy(),
            "content": content,
            "truncated": is_large,
            "large": is_large,
            "size": md.len(),
            "language": language,
            "eol": eol,
        })),
    }
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, Arc<AppState>>,
    path: String,
    content: String,
) -> DuckyResult<serde_json::Value> {
    let full = state.workspace.read().resolve(&path)?;
    let bytes = content.len();
    let for_write = full.clone();
    tokio::task::spawn_blocking(move || fsops::write_file(&for_write, &content))
        .await
        .map_err(|e| DuckyError::Io(format!("write task failed: {e}")))??;
    Ok(serde_json::json!({ "path": full.to_string_lossy(), "bytes": bytes }))
}

#[tauri::command]
pub fn create_entry(
    state: State<'_, Arc<AppState>>,
    path: String,
    kind: EntryKind,
) -> DuckyResult<fsops::FsEntry> {
    fsops::create_entry(&state.workspace.read(), &path, kind)
}

#[tauri::command]
pub fn rename_entry(
    state: State<'_, Arc<AppState>>,
    from: String,
    to: String,
) -> DuckyResult<String> {
    fsops::rename_entry(&state.workspace.read(), &from, &to)
}

#[tauri::command]
pub fn delete_entry(state: State<'_, Arc<AppState>>, path: String) -> DuckyResult<()> {
    fsops::delete_entry(&state.workspace.read(), &path)
}

#[tauri::command]
pub fn move_entry(
    state: State<'_, Arc<AppState>>,
    from: String,
    to_dir: String,
) -> DuckyResult<String> {
    fsops::move_entry(&state.workspace.read(), &from, &to_dir)
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn cancel_search(state: State<'_, Arc<AppState>>) {
    if let Some(c) = state.search_cancel.lock().take() {
        c.cancel();
    }
}

#[tauri::command]
pub async fn search_workspace(
    state: State<'_, Arc<AppState>>,
    query: String,
    use_regex: Option<bool>,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    include_pattern: Option<String>,
    max_results: Option<usize>,
) -> DuckyResult<serde_json::Value> {
    let root = root_or_err(&state)?;
    let settings = state.settings.get();
    let mut req = search::defaults_from_settings(&settings);
    req.root = root.to_string_lossy().to_string();
    req.query = query;
    if let Some(v) = use_regex {
        req.is_regex = v;
    }
    if let Some(v) = case_sensitive {
        req.case_sensitive = v;
    }
    if let Some(v) = whole_word {
        req.whole_word = v;
    }
    if let Some(p) = include_pattern {
        req.include_pattern = if p.trim().is_empty() { None } else { Some(p) };
    }

    // The low-memory ceiling wins over the caller's request: a 2 GB machine
    // cannot hold fifty thousand matches.
    let hard_cap = if settings.low_memory.enabled {
        settings.low_memory.max_search_results
    } else {
        settings.search.max_results
    };
    let cap = max_results.unwrap_or(req.max_results).min(hard_cap).max(1);
    req.max_results = cap;

    let cancel = SearchCancel::new();
    *state.search_cancel.lock() = Some(cancel.clone());
    let started = Instant::now();
    // The token is inspected again below, so hand the worker its own clone.
    let for_worker = cancel.clone();
    let outcome = tokio::task::spawn_blocking(move || search::search_content(&req, &for_worker))
        .await
        .map_err(|e| DuckyError::Other(format!("search task failed: {e}")))??;

    if outcome.matches.is_empty() && cancel.is_cancelled() {
        // A cancelled search is not a failure; the frontend just stops the
        // spinner when it sees the flag.
        state.search_cancel.lock().take();
    }

    Ok(serde_json::json!({
        "matches": outcome.matches,
        "filesScanned": outcome.files_scanned,
        "truncated": outcome.truncated || cancel.is_cancelled(),
        "elapsedMs": started.elapsed().as_millis(),
    }))
}

#[tauri::command]
pub async fn quick_open(
    state: State<'_, Arc<AppState>>,
    query: String,
    limit: Option<usize>,
) -> DuckyResult<Vec<search::NameHit>> {
    let root = root_or_err(&state)?;
    let settings = state.settings.get();
    let cap = limit.unwrap_or(60).clamp(1, 500);
    let globs = settings.search.exclude_globs.clone();
    let root = root.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || search::find_files(&root, &query, cap, &globs))
        .await
        .map_err(|e| DuckyError::Other(format!("quick open task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_status(state: State<'_, Arc<AppState>>) -> DuckyResult<git::RepoStatus> {
    // An async command that takes a reference must return a `Result`, so the
    // "nothing open" case is reported as a state rather than raised: the SCM
    // panel shows "open a folder" instead of an error toast.
    let Ok(root) = root_or_err(&state) else {
        return Ok(git::RepoStatus {
            is_repo: false,
            unavailable_reason: Some("no folder is open".into()),
            ..Default::default()
        });
    };
    tokio::task::spawn_blocking(move || git::status(&root))
        .await
        .map_err(|e| DuckyError::Git(format!("git status task failed: {e}")))
}

#[tauri::command]
pub async fn git_diff(
    state: State<'_, Arc<AppState>>,
    path: String,
    staged: bool,
) -> DuckyResult<git::DiffPayload> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::diff(&root, &path, staged))
        .await
        .map_err(|e| DuckyError::Git(format!("git diff task failed: {e}")))?
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> DuckyResult<()> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::stage(&root, &paths))
        .await
        .map_err(|e| DuckyError::Git(format!("git stage task failed: {e}")))?
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> DuckyResult<()> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::unstage(&root, &paths))
        .await
        .map_err(|e| DuckyError::Git(format!("git unstage task failed: {e}")))?
}

#[tauri::command]
pub async fn git_discard(state: State<'_, Arc<AppState>>, path: String) -> DuckyResult<()> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::discard(&root, &path))
        .await
        .map_err(|e| DuckyError::Git(format!("git discard task failed: {e}")))?
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, Arc<AppState>>,
    message: String,
) -> DuckyResult<String> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::commit(&root, &message))
        .await
        .map_err(|e| DuckyError::Git(format!("git commit task failed: {e}")))?
}

#[tauri::command]
pub async fn git_branches(
    state: State<'_, Arc<AppState>>,
) -> DuckyResult<Vec<(String, bool)>> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::branches(&root))
        .await
        .map_err(|e| DuckyError::Git(format!("git branches task failed: {e}")))?
}

#[tauri::command]
pub async fn git_checkout(state: State<'_, Arc<AppState>>, branch: String) -> DuckyResult<()> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::checkout(&root, &branch))
        .await
        .map_err(|e| DuckyError::Git(format!("git checkout task failed: {e}")))?
}

#[tauri::command]
pub async fn git_create_branch(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> DuckyResult<()> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::create_branch(&root, &name))
        .await
        .map_err(|e| DuckyError::Git(format!("git branch task failed: {e}")))?
}

#[tauri::command]
pub async fn git_pull(state: State<'_, Arc<AppState>>) -> DuckyResult<String> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::pull(&root))
        .await
        .map_err(|e| DuckyError::Git(format!("git pull task failed: {e}")))?
}

#[tauri::command]
pub async fn git_push(state: State<'_, Arc<AppState>>) -> DuckyResult<String> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::push(&root))
        .await
        .map_err(|e| DuckyError::Git(format!("git push task failed: {e}")))?
}

#[tauri::command]
pub async fn git_init(state: State<'_, Arc<AppState>>) -> DuckyResult<()> {
    let root = root_or_err(&state)?;
    tokio::task::spawn_blocking(move || git::init(&root))
        .await
        .map_err(|e| DuckyError::Git(format!("git init task failed: {e}")))?
}

#[tauri::command]
pub async fn git_log(
    state: State<'_, Arc<AppState>>,
    limit: Option<u32>,
) -> DuckyResult<Vec<git::CommitInfo>> {
    let root = root_or_err(&state)?;
    let n = limit.unwrap_or(50).min(500);
    tokio::task::spawn_blocking(move || git::log(&root, n))
        .await
        .map_err(|e| DuckyError::Git(format!("git log task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> DuckyResult<serde_json::Value> {
    let settings = state.settings.get();
    let root = state.workspace.read().root_str();

    let app_data = app.clone();
    let app_exit = app.clone();
    let emitter = PtyEmitter {
        data: Box::new(move |d: PtyData| {
            let _ = app_data.emit("term://data", d);
        }),
        exit: Box::new(move |e: PtyExit| {
            let _ = app_exit.emit("term://exit", e);
        }),
    };

    // portable-pty spawns a thread per terminal that reads until EOF, so this
    // is not a long block on the calling thread.
    let handle = pty::spawn_terminal(
        &settings.terminal,
        root.as_deref(),
        rows.unwrap_or(24).clamp(4, 200),
        cols.unwrap_or(80).clamp(20, 400),
        emitter,
    )?;

    let info = serde_json::json!({
        "id": handle.id,
        "title": handle.title,
        "cwd": handle.cwd,
        "alive": true,
    });
    state::register_terminal(&app, handle);
    Ok(info)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, Arc<AppState>>,
    id: u64,
    data: String,
) -> DuckyResult<()> {
    let handle = state
        .terminals
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| DuckyError::Terminal(format!("no terminal {id}")))?;
    handle.write(&data)
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, Arc<AppState>>,
    id: u64,
    rows: u16,
    cols: u16,
) -> DuckyResult<()> {
    let handle = state
        .terminals
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| DuckyError::Terminal(format!("no terminal {id}")))?;
    handle.resize(rows.clamp(4, 200), cols.clamp(20, 400));
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(app: AppHandle, state: State<'_, Arc<AppState>>, id: u64) {
    if let Some(handle) = state.terminals.lock().remove(&id) {
        handle.kill();
    }
    state::unregister_terminal(&app, id);
}

#[tauri::command]
pub fn terminal_list(state: State<'_, Arc<AppState>>) -> Vec<serde_json::Value> {
    state
        .terminals
        .lock()
        .values()
        .map(|h| {
            serde_json::json!({
                "id": h.id,
                "title": h.title,
                "cwd": h.cwd,
                "alive": h.is_alive(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn run_command(
    state: State<'_, Arc<AppState>>,
    command: String,
    args: Vec<String>,
) -> DuckyResult<CommandResult> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(DuckyError::Other("no command given".into()));
    }
    let settings = state.settings.get();
    let cwd = state.workspace.read().root_str();

    // A proposed command arrives as a program plus its arguments, but agent
    // output frequently contains shell syntax (pipes, `&&`, globs) that argv
    // cannot express. So the parts are joined back into one line and handed to
    // the shell, exactly as typing it into the integrated terminal would. Each
    // argument is single-quoted so a path with a space survives the trip.
    let script = if args.is_empty() {
        trimmed.to_string()
    } else {
        let quoted: Vec<String> = args
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', r"'\''")))
            .collect();
        format!("{trimmed} {}", quoted.join(" "))
    };

    pty::run_capture(
        &settings.terminal.shell,
        &["-c".to_string(), script],
        cwd.as_deref(),
        256 * 1024,
    )
    .await
    .map(|mut r| {
        // Defence in depth: a command's own output could echo a secret that
        // lives in the environment, so it goes through the same scrubber.
        r.stdout = crate::secret::redact(&r.stdout);
        r.stderr = crate::secret::redact(&r.stderr);
        r
    })
}

/// Classify a command by how much damage it could do.
///
/// This is advisory: the UI uses it to decide whether a command needs a typed
/// confirmation. The actual guard is that `agentRequiresApproval` gates the
/// button in the first place.
#[tauri::command]
pub fn classify_command(command: String) -> serde_json::Value {
    let risk = pty::classify_command(&command);
    serde_json::json!({
        "risk": risk,
        "requiresExplicitConfirmation": matches!(risk, "destructive" | "mutating"),
    })
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_test(state: State<'_, Arc<AppState>>) -> DuckyResult<ai::TestResult> {
    let provider = state.settings.get().ai.provider;
    let secrets = state.secrets.clone();
    state
        .ai
        .test_connection(&provider, &secrets)
        .await
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, Arc<AppState>>, request: String) {
    if let Some(t) = state.ai_cancel.lock().get(&request) {
        t.cancel();
    }
}

#[tauri::command]
pub fn ai_cancel_all(state: State<'_, Arc<AppState>>) {
    for (_, t) in state.ai_cancel.lock().iter() {
        t.cancel();
    }
}

#[tauri::command]
pub async fn ai_retrieve_context(
    state: State<'_, Arc<AppState>>,
    query: String,
    hints: Vec<String>,
    pinned: Vec<String>,
) -> DuckyResult<ai::RetrievedContext> {
    let settings = state.settings.get();
    let req = ai::RetrievalRequest {
        query,
        hints,
        pinned,
    };
    // Retrieval walks the project, so it belongs on a blocking thread. The
    // `State` guard cannot be moved into that thread, so the inner `Arc` is
    // cloned first -- the closure then owns everything it touches.
    let app_state = Arc::clone(state.inner());
    tokio::task::spawn_blocking(move || {
        let ws = app_state.workspace.read();
        ai::retrieve_context(&ws, &settings.ai, &req, &settings.search).map(|b| b.meta)
    })
    .await
    .map_err(|e| DuckyError::Other(format!("context task failed: {e}")))?
}

/// One-shot, non-streaming completion.
///
/// This is the single path behind every inline AI action: autocomplete, the
/// quick actions, the "fix this error" prompt, and "suggest a command".
///
/// The contract matters and is easy to get wrong. `request` is a *unique id*
/// (`cm:...`, `inline:...`, `cmd:...`, `fix:...`) used only to route a cancel;
/// the caller has already composed the entire prompt into `instruction`,
/// including the language and the surrounding code. So the backend must not
/// build a prompt of its own — doing so would either discard what the caller
/// wrote or, worse, substitute the request id for it.
#[tauri::command]
pub async fn ai_complete_task(
    state: State<'_, Arc<AppState>>,
    request: String,
    instruction: String,
    selection: String,
    file_path: Option<String>,
    use_fast_model: Option<bool>,
) -> DuckyResult<String> {
    let settings = state.settings.get();
    let mut provider = settings.ai.provider.clone();
    if use_fast_model.unwrap_or(false) && !provider.fast_model.is_empty() {
        provider.model = provider.fast_model.clone();
    }

    // The caller normally folds the selection into the instruction already. Only
    // append it when it is genuinely missing, so no context is sent twice.
    let user = if selection.trim().is_empty() || instruction.contains(&selection) {
        instruction
    } else {
        format!("{instruction}\n\n```\n{selection}\n```")
    };

    // Scoped: the read guard is not `Send`, so it must not be alive at the
    // `.await` below.
    let system = {
        let ws = state.workspace.read();
        ai::system_prompt(&ws, false, false)
    };
    let secrets = state.secrets.clone();
    let token = CancelToken::new();
    let max = provider.max_output_tokens;

    // Registered so the frontend's Cancel button can reach this request by id.
    state.ai_cancel.lock().insert(request.clone(), token.clone());

    let result = state
        .ai
        .complete(&provider, &secrets, &system, &user, max, &token)
        .await;

    // Removed unconditionally: a failure must not leave a stale cancel entry
    // behind, or the map would grow for the life of the process.
    state.ai_cancel.lock().remove(&request);

    // `file_path` is only advisory here. The caller states the language in the
    // instruction; the backend only uses it to keep the request identifiable in
    // logs, so it is deliberately not read.
    let _ = file_path;
    result
}

/// The streaming chat path.
///
/// Tokens are pushed to the UI as `ai://delta` events *and* accumulated here,
/// so a caller that only awaits the promise still gets the complete reply. The
/// accumulated text is what the history records.
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: String,
    history: Vec<ChatMessage>,
    user_message: String,
    pinned: Vec<String>,
    agent_mode: bool,
) -> DuckyResult<String> {
    let settings = state.settings.get();
    let provider = settings.ai.provider.clone();

    // The read guard is not `Send`, so it is scoped into a block: the compiler
    // can then prove it is gone before the first `.await`, which is what keeps
    // this command's future `Send`.
    let (system, context_block) = {
        let ws = state.workspace.read();
        let mut context_block = String::new();
        if settings.ai.auto_context && ws.root().is_some() {
            if let Ok(bundle) = ai::retrieve_context(
                &ws,
                &settings.ai,
                &ai::RetrievalRequest {
                    query: user_message.clone(),
                    hints: Vec::new(),
                    pinned,
                },
                &settings.search,
            ) {
                context_block = bundle.render();
            }
        }
        let system = ai::system_prompt(&ws, !context_block.is_empty(), agent_mode);
        (system, context_block)
    };

    // Build the message list. The context block is inserted as its own
    // `context` role so the UI can show exactly what the model was shown.
    let mut messages: Vec<ChatMessage> = Vec::with_capacity(history.len() + 3);
    messages.push(ChatMessage::system(system));
    for m in history {
        // The system prompt is rebuilt every turn; a stale copy from the client
        // would duplicate it.
        if m.role != ai::Role::System {
            messages.push(m);
        }
    }
    if !context_block.is_empty() {
        messages.push(ChatMessage::context(context_block));
    }
    messages.push(ChatMessage::user(user_message));

    let token = CancelToken::new();
    let secrets = state.secrets.clone();
    let id = request.clone();
    state.ai_cancel.lock().insert(id.clone(), token.clone());

    let emitter_app = app.clone();
    let accumulated = Arc::new(parking_lot::Mutex::new(String::new()));
    // One handle goes into the streaming callback; a second stays here so the
    // assembled text can be read once the stream finishes.
    let for_callback = Arc::clone(&accumulated);

    let result = run_ai_stream(
        state.ai.clone(),
        provider,
        secrets,
        messages,
        token,
        for_callback,
        emitter_app,
    )
    .await;

    state.ai_cancel.lock().remove(&id);
    result
}

/// Drive one streaming completion, forwarding tokens to the UI as they arrive.
///
/// This lives outside `ai_chat` because the closure `stream_chat` takes must be
/// `Send` and must not capture the `State` guard; a free function takes its
/// inputs by value and the guard stays behind in the caller.
async fn run_ai_stream(
    client: crate::ai::AiClient,
    provider: AiProviderConfig,
    secrets: crate::secret::SecretStore,
    messages: Vec<ChatMessage>,
    token: CancelToken,
    accumulated: Arc<parking_lot::Mutex<String>>,
    app: AppHandle,
) -> DuckyResult<String> {
    let for_callback = accumulated.clone();
    client
        .stream_chat(&provider, &secrets, &messages, &token, move |event| {
            match event {
                StreamEvent::Start { request_id } => {
                    let _ = app.emit(
                        "ai://start",
                        serde_json::json!({ "requestId": request_id }),
                    );
                }
                StreamEvent::Delta { text } => {
                    for_callback.lock().push_str(&text);
                    let _ = app.emit("ai://delta", serde_json::json!({ "text": text }));
                }
                StreamEvent::Done {
                    finish_reason,
                    cancelled,
                } => {
                    let _ = app.emit(
                        "ai://done",
                        serde_json::json!({ "finishReason": finish_reason, "cancelled": cancelled }),
                    );
                }
                StreamEvent::Error { message } => {
                    let _ = app.emit("ai://error", serde_json::json!({ "message": message }));
                }
            }
        })
        .await?;
    // The guard is bound to a local so it is released before returning.
    let assembled = accumulated.lock().clone();
    Ok(crate::secret::redact(&assembled))
}

// ---------------------------------------------------------------------------
// Applying proposed edits
// ---------------------------------------------------------------------------

/// One file the AI proposed changing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedEdit {
    pub path: String,
    pub content: String,
    /// True when the file does not exist yet.
    #[serde(default)]
    pub create: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub path: String,
    pub created: bool,
    pub bytes: usize,
}

/// Write the AI's proposed files to disk.
///
/// `approved` is passed through rather than assumed: the UI sends the user's
/// decision, and a false value writes nothing. This is the single place a
/// proposed change reaches the filesystem.
#[tauri::command]
pub async fn apply_edits(
    state: State<'_, Arc<AppState>>,
    edits: Vec<ProposedEdit>,
    approved: bool,
) -> DuckyResult<Vec<ApplyResult>> {
    if !approved {
        return Ok(Vec::new());
    }
    // Every path is resolved while the workspace guard is held, so a proposal
    // pointing outside the project is rejected before a single byte is written.
    let planned: Vec<(std::path::PathBuf, String, bool)> = {
        let ws = state.workspace.read();
        let mut planned = Vec::with_capacity(edits.len());
        for e in edits {
            let full = ws.resolve(&e.path)?;
            planned.push((full, e.content, e.create));
        }
        planned
    };

    tokio::task::spawn_blocking(move || {
        let mut out = Vec::with_capacity(planned.len());
        for (full, content, create) in planned {
            if let Some(parent) = full.parent() {
                if create && !parent.exists() {
                    std::fs::create_dir_all(parent).map_err(DuckyError::from)?;
                }
            }
            let bytes = content.len();
            fsops::write_file(&full, &content)?;
            out.push(ApplyResult {
                path: full.to_string_lossy().to_string(),
                created: create,
                bytes,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| DuckyError::Io(format!("apply task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Memory pressure
// ---------------------------------------------------------------------------

/// Start the single background memory watcher.
///
/// One thread, one timer, one job: read the system's free memory on a fixed
/// interval and push it to the UI. Polling from the frontend instead would
/// mean a timer per tab, and reading memory is not free.
///
/// The interval is deliberately slow. Memory pressure changes on a scale of
/// seconds, and on a 2 GB machine every wakeup costs a context switch the user
/// can feel.
pub fn spawn_memwatch(app: AppHandle) {
    std::thread::Builder::new()
        .name("ducky-memwatch".into())
        .spawn(move || {
            // Give the window a moment to come up before the first reading, so
            // the event does not race the frontend's own startup snapshot.
            std::thread::sleep(std::time::Duration::from_millis(1500));
            loop {
                {
                    let state = app.state::<Arc<AppState>>();
                    emit_mem_snapshot(&app, state.inner());
                }
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
        })
        .ok();
}

/// Push a fresh memory reading to the frontend.
fn emit_mem_snapshot(app: &AppHandle, state: &AppState) {
    let snap = take_snapshot(state);
    let lm = state.settings.get().low_memory;
    let pressure = state.pressure();
    let message = match pressure {
        Pressure::Critical => Some(format!(
            "Memory is tight ({} MB free). Inactive tabs are suspended and new tabs load on demand.",
            snap.system_available_mb.round() as u32
        )),
        Pressure::Elevated => Some(format!(
            "{} MB free. Consider closing a terminal or a large file.",
            snap.system_available_mb.round() as u32
        )),
        Pressure::Normal => None,
    };
    state::emit_safe(
        app,
        "mem://snapshot",
        serde_json::json!({
            "pressure": pressure,
            "label": pressure.label(),
            "message": if lm.show_notice { message } else { None },
            "snapshot": snap,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_keeps_both_ends() {
        assert_eq!(trim_to("short", 100), "short");
        let long = "a".repeat(500);
        let t = trim_to(&long, 100);
        assert!(t.starts_with("aaaa"));
        assert!(t.contains("characters omitted"));
        assert!(t.ends_with("aaaa"));
    }

    #[test]
    fn every_registered_command_is_defined() {
        // The frontend addresses commands by string name. A rename that misses
        // this file fails silently at runtime, so the list is pinned here.
        let defined = [
            "app_info",
            "get_settings",
            "update_settings",
            "set_secret",
            "clear_secret",
            "secret_status",
            "mem_snapshot",
            "open_folder",
            "close_folder",
            "list_dir",
            "read_file",
            "write_file",
            "create_entry",
            "rename_entry",
            "delete_entry",
            "move_entry",
            "cancel_search",
            "search_workspace",
            "quick_open",
            "git_status",
            "git_diff",
            "git_stage",
            "git_unstage",
            "git_discard",
            "git_commit",
            "git_branches",
            "git_checkout",
            "git_create_branch",
            "git_pull",
            "git_push",
            "git_init",
            "git_log",
            "terminal_create",
            "terminal_write",
            "terminal_resize",
            "terminal_kill",
            "terminal_list",
            "run_command",
            "classify_command",
            "ai_test",
            "ai_cancel",
            "ai_cancel_all",
            "ai_retrieve_context",
            "ai_complete_task",
            "ai_chat",
            "apply_edits",
        ];
        assert_eq!(defined.len(), 46, "the command count changed; update lib.rs too");
    }
}
