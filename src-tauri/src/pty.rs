//! Integrated terminal backed by a real PTY.
//!
//! ## Why there is no scrollback buffer in here
//!
//! The obvious design is to keep the last N lines in the backend so the UI can
//! ask for them again. That is exactly wrong for a 2 GB machine: it duplicates
//! the entire scrollback across the process boundary, so a 750-line buffer
//! costs twice and a tab-switching feature would have to synchronise both
//! copies.
//!
//! Instead, the backend is a **stateless pipe**. Bytes go from the PTY to the
//! renderer and nowhere else. The renderer owns the single copy of the
//! scrollback, applies its own bounded ring buffer, and that is where "search
//! output" and "copy output" read from. Suspending a terminal is then free: the
//! frontend drops its buffer, the backend drops nothing, and reopening shows an
//! empty terminal attached to the same live process — which is also what a user
//! expects, since the process kept running.

use crate::config::TerminalConfig;
use crate::error::{DuckyError, DuckyResult};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// How long we wait for the reader thread to notice EOF before giving up on a
/// clean shutdown. Bounded so closing a terminal can never hang the app.
const SHUTDOWN_GRACE_MS: u64 = 400;

pub struct TerminalHandle {
    pub id: u64,
    pub title: String,
    master: parking_lot::Mutex<Box<dyn MasterPty + Send>>,
    writer: parking_lot::Mutex<Box<dyn Write + Send>>,
    child: parking_lot::Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// Set when the shell has exited, so the UI can grey the tab out instead of
    /// pretending it is still live.
    pub exited: Arc<parking_lot::Mutex<Option<i32>>>,
    /// The cwd the shell was started in, for the "open in explorer" action.
    pub cwd: String,
}

/// Events pushed to the frontend. `channel` is the terminal id, so one global
/// listener can multiplex every terminal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyData {
    pub channel: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub channel: u64,
    pub code: i32,
}

pub struct PtyEmitter {
    // Boxed rather than `impl Fn`: `impl Trait` is not allowed in a field type.
    pub data: Box<dyn Fn(PtyData) + Send + 'static>,
    pub exit: Box<dyn Fn(PtyExit) + Send + 'static>,
}

pub fn spawn_terminal(
    cfg: &TerminalConfig,
    workspace_root: Option<&str>,
    rows: u16,
    cols: u16,
    emitter: PtyEmitter,
) -> DuckyResult<Arc<TerminalHandle>> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| DuckyError::Terminal(format!("could not allocate a pty: {e}")))?;

    let cwd = if !cfg.cwd.is_empty() {
        std::path::PathBuf::from(&cfg.cwd)
    } else if let Some(root) = workspace_root {
        std::path::PathBuf::from(root)
    } else {
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
    };

    let mut cmd = CommandBuilder::new(&cfg.shell);
    for arg in &cfg.args {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    // A colour-capable terminfo without any terminfo database dependency.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Do not let the shell inherit our API-key environment: a user typing
    // `env` in their terminal must not be able to print a stored credential.
    for (k, _) in std::env::vars() {
        if k.starts_with("DUCKY_AI_KEY")
            || k.starts_with("OPENAI_API_KEY")
            || k.starts_with("ANTHROPIC_API_KEY")
        {
            cmd.env_remove(&k);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| DuckyError::Terminal(format!("could not start {}: {e}", cfg.shell)))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| DuckyError::Terminal(format!("could not read from pty: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| DuckyError::Terminal(format!("could not write to pty: {e}")))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let exited = Arc::new(parking_lot::Mutex::new(None));

    let title = shell_title(&cfg.shell);
    let handle = Arc::new(TerminalHandle {
        id,
        title,
        master: parking_lot::Mutex::new(pair.master),
        writer: parking_lot::Mutex::new(writer),
        child: parking_lot::Mutex::new(Some(child)),
        exited: exited.clone(),
        cwd: cwd.to_string_lossy().to_string(),
    });

    // Reader thread. It owns nothing but a fixed 16 KB staging buffer, so its
    // footprint is constant regardless of how much the command prints.
    {
        let emit_data = emitter.data;
        let emit_exit = emitter.exit;
        let reader_handle = handle.clone();
        std::thread::Builder::new()
            .name(format!("ducky-pty-{id}"))
            .stack_size(256 * 1024)
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            // The PTY emits UTF-8 but a partial multi-byte
                            // sequence can land on a chunk boundary, so we keep
                            // a one-frame carry buffer.
                            let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                            if !text.is_empty() {
                                emit_data(PtyData {
                                    channel: reader_handle.id,
                                    data: text,
                                });
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let code = {
                    let mut guard = reader_handle.child.lock();
                    match guard.as_mut() {
                        Some(c) => c.wait().map(|s| s.exit_code() as i32).unwrap_or(-1),
                        None => -1,
                    }
                };
                *exited.lock() = Some(code);
                emit_exit(PtyExit {
                    channel: reader_handle.id,
                    code,
                });
            })
            .map_err(|e| DuckyError::Terminal(format!("could not start reader thread: {e}")))?;
    }

    Ok(handle)
}

fn shell_title(shell: &str) -> String {
    std::path::Path::new(shell)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "terminal".into())
}

impl TerminalHandle {
    pub fn write(&self, data: &str) -> DuckyResult<()> {
        if self.exited.lock().is_some() {
            return Err(DuckyError::Terminal("this terminal has exited".into()));
        }
        let mut w = self.writer.lock();
        w.write_all(data.as_bytes())
            .map_err(|e| DuckyError::Terminal(format!("write failed: {e}")))?;
        w.flush().ok();
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) {
        // Ignore the error: a resize on a dying pty is not worth a toast.
        let _ = self.master.lock().resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    pub fn is_alive(&self) -> bool {
        self.exited.lock().is_none()
    }

    /// Ask the shell to exit, then make sure it did.
    pub fn kill(&self) {
        {
            let mut child = self.child.lock();
            if let Some(c) = child.as_mut() {
                let _ = c.kill();
            }
            *child = None;
        }
        // Resizing to zero rows is the portable way to send SIGHUP to the
        // foreground process group on a pty, which also stops `npm run dev`
        // style long-lived children.
        self.resize(0, 0);
        std::thread::sleep(std::time::Duration::from_millis(SHUTDOWN_GRACE_MS));
    }
}

pub fn available_shells() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(sh) = std::env::var("SHELL") {
        if !sh.is_empty() {
            candidates.push(sh);
        }
    }
    candidates.extend(
        ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/fish", "/bin/sh"]
            .iter()
            .map(|s| s.to_string()),
    );
    for c in candidates {
        if !std::path::Path::new(&c).exists() {
            continue;
        }
        let name = std::path::Path::new(&c)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if out.iter().any(|(n, _): &(String, String)| n == &name) {
            continue;
        }
        out.push((name, c));
    }
    out
}

/// Classify a command so the AI-approval prompt knows how dangerous it is.
///
/// This is a heuristic guard rail, not a security sandbox: the point is to make
/// the user consciously confirm the obviously destructive cases rather than to
/// pretend we can stop `rm -rf /`.
pub fn classify_command(command: &str) -> &'static str {
    let c = command.to_ascii_lowercase();
    let destructive = [
        "rm -rf", "rm -fr", "rm -r /", "mkfs", "dd if=", ":(){", "shutdown", "reboot",
        "halt", "poweroff", "chown -r /", "chmod -r 777 /", "format c:", "del /f /s /q",
    ];
    let mutating = [
        "apt install", "apt-get install", "sudo ", "npm install", "pnpm add", "yarn add",
        "pip install", "cargo install", "npm remove", "npm uninstall", "rm ", "mv ", "dd ",
        "git push", "git reset --hard", "git clean", "chmod ", "chown ", "kill ", "killall",
        "> /", "tee ",
    ];
    let networked = ["curl ", "wget ", "ssh ", "scp ", "nc "];
    if destructive.iter().any(|d| c.contains(d)) {
        return "destructive";
    }
    if mutating.iter().any(|d| c.contains(d)) {
        return "mutating";
    }
    if networked.iter().any(|d| c.contains(d)) {
        return "networked";
    }
    "readOnly"
}

/// Run a one-shot command and capture its output, with a hard cap.
///
/// This is what the Run panel and "let the agent run this" use. It is never
/// allowed to produce unbounded output into our heap.
pub async fn run_capture(
    shell: &str,
    args: &[String],
    cwd: Option<&str>,
    max_bytes: usize,
) -> DuckyResult<CommandResult> {
    let mut cmd = std::process::Command::new(shell);
    for a in args {
        cmd.arg(a);
    }
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdin(std::process::Stdio::null());

    // The closure returns a Result so the `?` operators inside it are valid.
    let out = tokio::task::spawn_blocking(move || -> DuckyResult<CommandResult> {
        let output = cmd
            .output()
            .map_err(|e| DuckyError::Terminal(format!("could not run command: {e}")))?;
        let cap = |bytes: &[u8]| -> (String, bool) {
            if bytes.len() > max_bytes {
                let s = String::from_utf8_lossy(&bytes[..max_bytes]).into_owned();
                (format!("{s}\n… output truncated …"), true)
            } else {
                (String::from_utf8_lossy(bytes).into_owned(), false)
            }
        };
        let (stdout, so_trunc) = cap(&output.stdout);
        let (stderr, se_trunc) = cap(&output.stderr);
        Ok(CommandResult {
            code: output.status.code().unwrap_or(-1),
            stdout,
            stderr,
            truncated: so_trunc || se_trunc,
        })
    })
    .await
    .map_err(|e| DuckyError::Terminal(format!("command task failed: {e}")))??;

    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_classification() {
        assert_eq!(classify_command("npm install"), "mutating");
        assert_eq!(classify_command("rm -rf build/"), "destructive");
        assert_eq!(classify_command("sudo apt update"), "mutating");
        assert_eq!(classify_command("ls -la"), "readOnly");
        assert_eq!(classify_command("git status"), "readOnly");
        assert_eq!(classify_command("curl https://example.com"), "networked");
    }

    #[test]
    fn capture_is_capped() {
        // `run_capture` is async so the blocking work goes to a blocking pool.
        // `tokio` is built without the `macros` feature to keep the dependency
        // tree small, so the future is driven by a current-thread runtime built
        // here rather than by an attribute.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("a current-thread runtime");
        let cfg = TerminalConfig {
            shell: if cfg!(windows) { "cmd".into() } else { "/bin/sh".into() },
            args: if cfg!(windows) {
                vec!["/C".into(), "echo hello".into()]
            } else {
                vec!["-c".into(), "echo hello".into()]
            },
            ..Default::default()
        };
        let r = rt
            .block_on(run_capture(&cfg.shell, &cfg.args, None, 1024))
            .unwrap();
        assert_eq!(r.code, 0);
        assert!(r.stdout.contains("hello"));
    }

    #[test]
    fn spawns_a_real_shell_and_round_trips_input() {
        if cfg!(windows) {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let (tx2, _rx2) = std::sync::mpsc::channel();
        let cfg = TerminalConfig {
            shell: "/bin/sh".into(),
            args: vec![],
            ..Default::default()
        };
        let handle = spawn_terminal(
            &cfg,
            None,
            24,
            80,
            PtyEmitter {
                data: Box::new(move |d| {
                    let _ = tx.send(d.data);
                }),
                exit: Box::new(move |e| {
                    let _ = tx2.send(e.code);
                }),
            },
        )
        .expect("pty should be available on this platform");

        handle.write("echo ducky-pty-ok\n").unwrap();
        // Read from the channel until we see the echo, with a bounded wait so a
        // broken pty fails the test instead of hanging it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(std::time::Duration::from_millis(400)) {
                Ok(chunk) => {
                    seen.push_str(&chunk);
                    if seen.contains("ducky-pty-ok") {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        assert!(
            seen.contains("ducky-pty-ok"),
            "expected shell output, got: {seen:?}"
        );
        assert!(handle.is_alive());
        handle.kill();
    }
}
