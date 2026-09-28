//! Ducky Coder Lite — backend root.
//!
//! # Why this shape
//!
//! The whole application is built around one fact: the target machine has 2 GB
//! of RAM. Every structural decision below follows from it.
//!
//! ## No document store
//!
//! Open documents live in the webview, where they are being displayed anyway.
//! The backend re-reads a file from disk when a suspended tab is reopened. This
//! means there is exactly one copy of a document's text in the process tree,
//! there is no cache to invalidate, and closing a tab frees memory on both
//! sides of the bridge with no coordination.
//!
//! ## No repository index
//!
//! There is no symbol table, no file list and no content index. The explorer's
//! folder tree is built one `read_dir` at a time, exactly as the user expands
//! it. Search runs on demand and stops at its result cap. Context retrieval runs
//! a bounded search and reads excerpts. A 48,000-file repository therefore costs
//! the editor the same memory as a 12-file one.
//!
//! ## One watcher, not many
//!
//! Exactly one background thread exists, [`spawn_memwatch`], and it wakes every
//! two seconds to read `/proc/meminfo` and our own RSS. Nothing else polls: no
//! git status loop, no file watcher thread, no heartbeat, no telemetry. Terminal
//! reader threads are bounded in number (one per open terminal) and hold a
//! fixed 16 KB buffer each.
//!
//! ## Cooperative cancellation everywhere
//!
//! Search, streaming completions and autocomplete all take a cancel token that
//! the UI can trip. On a slow machine the difference between "the previous query
//! finishes eventually" and "the previous query stops now" is the difference
//! between usable and not.

pub mod ai;
pub mod commands;
pub mod config;
pub mod error;
pub mod fsops;
pub mod git;
pub mod meminfo;
pub mod pty;
pub mod search;
pub mod secret;
pub mod state;

use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    let config_dir = match state::AppState::config_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[ducky] cannot locate a config directory: {e}");
            return;
        }
    };

    let settings_store = match config::SettingsStore::load(&config_dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[ducky] cannot load settings: {e}");
            return;
        }
    };
    let secret_store = match secret::SecretStore::load(&config_dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[ducky] cannot open the credential store: {e}");
            return;
        }
    };

    let app_state = match state::AppState::new(settings_store, secret_store) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("[ducky] cannot start: {e}");
            return;
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the existing window instead of starting a
            // second editor, which on a 2 GB machine would be a memory problem
            // the user created by accident.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .setup(|app| {
            // Start the single background watcher.
            commands::spawn_memwatch(app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                let title = app
                    .state::<Arc<state::AppState>>()
                    .settings
                    .get()
                    .last_workspace
                    .as_deref()
                    .and_then(|p| {
                        std::path::Path::new(p)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                    });
                if let Some(name) = title {
                    let _ = window.set_title(&format!("{name} — Ducky Coder Lite"));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Never leave shells running behind us.
            if let tauri::WindowEvent::Destroyed = event {
                state::shutdown_terminals(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::update_settings,
            commands::set_secret,
            commands::clear_secret,
            commands::secret_status,
            commands::mem_snapshot,
            commands::open_folder,
            commands::close_folder,
            commands::list_dir,
            commands::read_file,
            commands::write_file,
            commands::create_entry,
            commands::rename_entry,
            commands::delete_entry,
            commands::move_entry,
            commands::cancel_search,
            commands::search_workspace,
            commands::quick_open,
            commands::git_status,
            commands::git_diff,
            commands::git_stage,
            commands::git_unstage,
            commands::git_discard,
            commands::git_commit,
            commands::git_branches,
            commands::git_checkout,
            commands::git_create_branch,
            commands::git_pull,
            commands::git_push,
            commands::git_init,
            commands::git_log,
            commands::terminal_create,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            commands::terminal_list,
            commands::run_command,
            commands::classify_command,
            commands::ai_test,
            commands::ai_cancel,
            commands::ai_cancel_all,
            commands::ai_retrieve_context,
            commands::ai_complete_task,
            commands::ai_chat,
            commands::apply_edits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ducky Coder Lite");
}
