//! Process-wide shared state.
//!
//! One `AppState` behind an `Arc`, containing every long-lived structure. The
//! important property here is what is *not* in it: there is no document cache,
//! no file-content store and no symbol index. Open documents live in the
//! webview (where they are being displayed anyway) and are re-read from disk on
//! demand, so closing a suspended tab frees memory on both sides of the bridge
//! with no coordination at all.

use crate::ai::AiClient;
use crate::config::SettingsStore;
use crate::error::DuckyResult;
use crate::fsops::Workspace;
use crate::pty::TerminalHandle;
use crate::search::SearchCancel;
use crate::secret::SecretStore;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Emitter;
// `AppHandle::state` comes from the `Manager` trait, and `try_state` is how we
// check for a live window before emitting.
use tauri::Manager;

/// The memory-pressure ladder. Each step is a discrete, escalating response;
/// the editor only ever moves down this ladder automatically, and it recovers
/// by moving back up when memory returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Pressure {
    /// Plenty of memory. Everything runs.
    Normal,
    /// Getting tight: trim caches, stop background indexing, fewer AI results.
    Elevated,
    /// Critical: suspend inactive tabs, pause language services, shrink AI
    /// context, stop search.
    Critical,
}

impl Pressure {
    pub fn label(self) -> &'static str {
        match self {
            Self::Normal => "",
            Self::Elevated => "ELEVATED",
            Self::Critical => "LOW MEMORY",
        }
    }
}

pub struct AppState {
    pub settings: SettingsStore,
    pub secrets: SecretStore,
    pub workspace: parking_lot::RwLock<Workspace>,
    pub ai: AiClient,
    /// Live terminals, keyed by id. Entries are removed when the shell exits, so
    /// a long session that opens and closes a hundred terminals does not
    /// accumulate a hundred handles.
    pub terminals: parking_lot::Mutex<BTreeMap<u64, Arc<TerminalHandle>>>,
    /// The in-flight workspace search, so a new query can cancel the old one.
    pub search_cancel: parking_lot::Mutex<Option<SearchCancel>>,
    /// In-flight AI requests, so Escape can stop token spend.
    pub ai_cancel: parking_lot::Mutex<BTreeMap<String, crate::ai::CancelToken>>,
    /// Current pressure, published to the frontend for the status bar.
    pub pressure: AtomicU32,
    pub started_at: std::time::Instant,
}

impl AppState {
    pub fn new(settings: SettingsStore, secrets: SecretStore) -> DuckyResult<Self> {
        Ok(Self {
            settings,
            secrets,
            workspace: parking_lot::RwLock::new(Workspace::new()),
            ai: AiClient::new(),
            terminals: parking_lot::Mutex::new(BTreeMap::new()),
            search_cancel: parking_lot::Mutex::new(None),
            ai_cancel: parking_lot::Mutex::new(BTreeMap::new()),
            pressure: AtomicU32::new(0),
            started_at: std::time::Instant::now(),
        })
    }

    pub fn pressure(&self) -> Pressure {
        match self.pressure.load(Ordering::Relaxed) {
            0 => Pressure::Normal,
            1 => Pressure::Elevated,
            _ => Pressure::Critical,
        }
    }

    pub fn set_pressure(&self, p: Pressure) {
        self.pressure.store(p as u32, Ordering::Relaxed);
    }

    pub fn config_dir() -> DuckyResult<PathBuf> {
        dirs::config_dir()
            .or_else(dirs::home_dir)
            .map(|d| d.join("DuckyCoderLite"))
            .ok_or_else(|| {
                crate::error::DuckyError::Config("no config directory available".into())
            })
    }

    /// Uptime, for the status bar's uptime tooltip.
    pub fn uptime_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }
}

/// Decide the pressure level from a memory snapshot.
///
/// Deliberately conservative about *recovering*: hysteresis means a machine
/// hovering at the threshold does not flap between two behaviours, which would
/// look like the editor is thrashing.
pub fn evaluate_pressure(
    snap: &crate::meminfo::MemSnapshot,
    current: Pressure,
    low_mem_enabled: bool,
    shed_mb: u32,
    critical_mb: u32,
) -> Pressure {
    if !low_mem_enabled {
        return Pressure::Normal;
    }
    let available = snap.system_available_mb;
    let shed = shed_mb as f64;
    let critical = critical_mb as f64;

    let next = if available < critical {
        Pressure::Critical
    } else if available < shed {
        match current {
            // Require more headroom to come back up than to fall.
            Pressure::Critical if available < critical + 64.0 => Pressure::Critical,
            _ => Pressure::Elevated,
        }
    } else if available < shed + 64.0 {
        // Back inside the shed band but not comfortably: stay where we are.
        current
    } else {
        Pressure::Normal
    };
    next
}

/// Register a terminal so the app can clean it up on exit.
pub fn register_terminal(app: &AppHandle, handle: Arc<TerminalHandle>) {
    let state = app.state::<Arc<AppState>>();
    state
        .terminals
        .lock()
        .insert(handle.id, handle.clone());

    // Clean up when the shell exits so the map does not grow without bound.
    let app2 = app.clone();
    let id = handle.id;
    std::thread::Builder::new()
        .name("ducky-pty-reaper".into())
        .stack_size(64 * 1024)
        .spawn(move || {
            loop {
                if !handle.is_alive() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            if let Some(state) = app2.try_state::<Arc<AppState>>() {
                state.terminals.lock().remove(&id);
            }
        })
        .ok();
}

pub fn unregister_terminal(app: &AppHandle, id: u64) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        if let Some(handle) = state.terminals.lock().remove(&id) {
            handle.kill();
        }
    }
}

/// Kill every terminal. Called on window close so we never leak a shell
/// process (and its memory) after the editor has gone.
pub fn shutdown_terminals(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        let mut guard = state.terminals.lock();
        let handles: Vec<Arc<TerminalHandle>> = guard.values().cloned().collect();
        guard.clear();
        for handle in handles {
            handle.kill();
        }
    }
}

/// Emit an event only if the frontend is still listening; a closed window must
/// not turn into a stream of failed emissions.
pub fn emit_safe(app: &AppHandle, event: &str, payload: serde_json::Value) {
    let _ = app.emit(event, payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meminfo::MemSnapshot;

    fn snap(available_mb: f64) -> MemSnapshot {
        MemSnapshot {
            system_total_mb: 2048.0,
            system_available_mb: available_mb,
            ..Default::default()
        }
    }

    #[test]
    fn pressure_ladder_responds_to_free_memory() {
        // Abundant memory: normal.
        assert_eq!(evaluate_pressure(&snap(1024.0), Pressure::Normal, true, 256, 128), Pressure::Normal);
        // Below the shed threshold: elevated.
        assert_eq!(evaluate_pressure(&snap(200.0), Pressure::Normal, true, 256, 128), Pressure::Elevated);
        // Below the critical threshold: critical.
        assert_eq!(evaluate_pressure(&snap(90.0), Pressure::Normal, true, 256, 128), Pressure::Critical);
    }

    #[test]
    fn low_memory_mode_off_disables_the_ladder() {
        assert_eq!(evaluate_pressure(&snap(10.0), Pressure::Normal, false, 256, 128), Pressure::Normal);
    }

    #[test]
    fn pressure_does_not_flap() {
        // Recovering from critical needs real headroom, not a token amount.
        assert_eq!(
            evaluate_pressure(&snap(150.0), Pressure::Critical, true, 256, 128),
            Pressure::Critical
        );
        // Comfortably inside the band: back to normal.
        assert_eq!(
            evaluate_pressure(&snap(400.0), Pressure::Critical, true, 256, 128),
            Pressure::Normal
        );
    }
}
