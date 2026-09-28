//! Git integration.
//!
//! Every operation shells out to the `git` binary and parses plain text. There
//! is no libgit2: linking it would add several megabytes of resident code to an
//! app whose entire premise is a small memory footprint, and the CLI is present
//! on every machine that has a repository anyway.
//!
//! The other rule: **nothing runs on a timer.** Status is fetched when the SCM
//! view opens, when the user acts, and when the user asks to refresh. A poll
//! loop calling `git status` every few seconds is exactly the kind of
//! background work this app refuses to do.

use crate::error::{DuckyError, DuckyResult};
use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    Conflicted,
    Clean,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// Workspace-relative path.
    pub path: String,
    /// Path before a rename, if any.
    pub original_path: Option<String>,
    pub status: FileStatus,
    pub staged: bool,
    pub index_status: Option<String>,
    pub worktree_status: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub detached: bool,
    pub entries: Vec<StatusEntry>,
    pub has_conflicts: bool,
    /// Present only when `git` is missing or the folder is not a repository.
    pub unavailable_reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub path: String,
    pub staged: bool,
    /// Unified diff text. Empty when there is no change.
    pub patch: String,
    /// True when the file is new or deleted, i.e. there is no "before" text.
    pub is_binary: bool,
    pub additions: u32,
    pub deletions: u32,
    pub old_path: Option<String>,
    pub error: Option<String>,
}

fn git_bin() -> Option<String> {
    std::env::var("DUCKY_GIT_BIN")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            // Cheap existence probe; avoids spawning a process just to fail.
            let candidate = if cfg!(windows) { "git.exe" } else { "git" };
            which(candidate)
        })
}

/// Minimal PATH lookup so we do not have to spawn `git --version` to find out
/// whether git exists.
fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|s| s.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = dir.join(format!("{bin}{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

struct GitOutput {
    status: i32,
    stdout: String,
    stderr: String,
}

fn run(cwd: &Path, args: &[&str]) -> DuckyResult<GitOutput> {
    let bin = git_bin().ok_or_else(|| {
        DuckyError::Git("git is not installed or not on PATH".into())
    })?;
    let out = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        // Keep git's own pager and prompts out of the way: we render output
        // ourselves and must never block on a TTY.
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| DuckyError::Git(format!("could not run git: {e}")))?;
    Ok(GitOutput {
        status: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Read the working-tree status. This is the only "poll-like" call in the app
/// and it is always triggered by the user or by a file-save event.
pub fn status(root: &Path) -> RepoStatus {
    if git_bin().is_none() {
        return RepoStatus {
            is_repo: false,
            unavailable_reason: Some("git is not installed or not on PATH".into()),
            ..Default::default()
        };
    }

    let Ok(top) = run(root, &["rev-parse", "--show-toplevel"]) else {
        return RepoStatus {
            is_repo: false,
            unavailable_reason: Some("could not run git in this folder".into()),
            ..Default::default()
        };
    };
    if top.status != 0 {
        return RepoStatus {
            is_repo: false,
            unavailable_reason: Some("not a git repository".into()),
            ..Default::default()
        };
    }

    let repo_root = top.stdout.trim().to_string();

    // `--porcelain=v1 -z --branch --untracked-files=all` gives a stable,
    // NUL-delimited format that handles spaces and non-ASCII in filenames
    // without any quoting rules.
    let out = match run(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    ) {
        Ok(o) => o,
        Err(e) => {
            return RepoStatus {
                is_repo: true,
                root: Some(repo_root),
                unavailable_reason: Some(e.to_string()),
                ..Default::default()
            }
        }
    };

    let mut status = RepoStatus {
        is_repo: true,
        root: Some(repo_root),
        ..Default::default()
    };

    let mut fields = out.stdout.split('\0').peekable();
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        if field.starts_with("## ") {
            parse_branch_line(field, &mut status);
            continue;
        }
        if field.len() < 3 {
            continue;
        }
        let bytes = field.as_bytes();
        let index_code = bytes[0] as char;
        let worktree_code = bytes[1] as char;
        let path = field[2..].to_string();

        if index_code == 'R' || index_code == 'C' {
            // Renames are "XY <new>\0<old>" — the old path is the next field.
            let original = fields.next().map(|s| s.to_string());
            let staged = index_code != ' ' && index_code != '?';
            status.entries.push(StatusEntry {
                status: if index_code == 'R' {
                    FileStatus::Renamed
                } else {
                    FileStatus::Copied
                },
                original_path: original,
                path,
                staged,
                index_status: Some(index_code.to_string()),
                worktree_status: Some(worktree_code.to_string()),
            });
            continue;
        }

        let (file_status, staged) = if index_code == '?' && worktree_code == '?' {
            (FileStatus::Untracked, false)
        } else if index_code == 'U' || worktree_code == 'U' || (index_code == 'A' && worktree_code == 'A') || (index_code == 'D' && worktree_code == 'D') {
            (FileStatus::Conflicted, true)
        } else {
            let code = if index_code != ' ' { index_code } else { worktree_code };
            (
                match code {
                    'A' => FileStatus::Added,
                    'M' => FileStatus::Modified,
                    'D' => FileStatus::Deleted,
                    'R' => FileStatus::Renamed,
                    'C' => FileStatus::Copied,
                    'I' => FileStatus::Ignored,
                    '?' => FileStatus::Untracked,
                    _ => FileStatus::Clean,
                },
                index_code != ' ' && index_code != '?',
            )
        };

        if file_status == FileStatus::Conflicted {
            status.has_conflicts = true;
        }
        if file_status != FileStatus::Clean {
            status.entries.push(StatusEntry {
                path,
                original_path: None,
                status: file_status,
                staged,
                index_status: Some(index_code.to_string()),
                worktree_status: Some(worktree_code.to_string()),
            });
        }
    }

    status
}

fn parse_branch_line(line: &str, status: &mut RepoStatus) {
    // `## main...origin/main [ahead 1, behind 2]`
    let body = line.trim_start_matches("## ");
    let (head, rest) = match body.split_once("...") {
        Some((h, r)) => (h, Some(r)),
        None => (body, None),
    };
    status.detached = head.starts_with("HEAD (no branch)");
    status.branch = Some(head.to_string());
    if let Some(rest) = rest {
        let (upstream, counts) = match rest.split_once(" [") {
            Some((u, c)) => (u, Some(c.trim_end_matches(']'))),
            None => (rest, None),
        };
        status.upstream = Some(upstream.to_string());
        if let Some(counts) = counts {
            for part in counts.split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    status.ahead = n.trim().parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    status.behind = n.trim().parse().unwrap_or(0);
                }
            }
        }
    }
}

pub fn diff(root: &Path, path: &str, staged: bool) -> DuckyResult<DiffPayload> {
    let args: Vec<&str> = if staged {
        vec!["diff", "--cached", "--no-color", "--no-ext-diff", "--", path]
    } else {
        vec!["diff", "--no-color", "--no-ext-diff", "--", path]
    };
    // Untracked files have no diff at all; synthesise an "add everything"
    // patch so the review UI can still show the user what they are about to
    // commit.
    let out = run(root, &args)?;
    let (patch, error) = if out.status != 0 {
        (String::new(), Some(out.stderr.trim().to_string()))
    } else {
        (out.stdout, None)
    };

    let mut payload = DiffPayload {
        path: path.to_string(),
        staged,
        patch,
        is_binary: false,
        additions: 0,
        deletions: 0,
        old_path: None,
        error,
    };

    if payload.patch.is_empty() {
        if let Ok(p) = Path::new(path).strip_prefix(root) {
            let full = root.join(p);
            if full.exists() {
                // Treat as new file: `git diff --no-index` against /dev/null.
                let mut args: Vec<&str> =
                    vec!["diff", "--no-color", "--no-ext-diff", "--no-index", "/dev/null", path];
                if let Ok(o) = run(root, &args) {
                    payload.patch = o.stdout;
                }
            }
        }
    }

    count_changes(&mut payload);
    Ok(payload)
}

fn count_changes(payload: &mut DiffPayload) {
    if payload.patch.contains("Binary files ") || payload.patch.contains("GIT binary patch") {
        payload.is_binary = true;
    }
    for line in payload.patch.lines() {
        if let Some(rest) = line.strip_prefix("+++ ") {
            if rest == "/dev/null" {
                payload.old_path = Some(String::new());
            } else {
                payload.old_path = Some(rest.trim_start_matches('b').to_string());
            }
        }
        if line.starts_with('+') && !line.starts_with("+++") {
            payload.additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            payload.deletions += 1;
        }
    }
}

pub fn stage(root: &Path, paths: &[String]) -> DuckyResult<()> {
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    let out = run(root, &args)?;
    check(out, "stage")
}

pub fn unstage(root: &Path, paths: &[String]) -> DuckyResult<()> {
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    let out = run(root, &args)?;
    if out.status != 0 {
        // Older git has no `restore`; fall back to `reset HEAD --`.
        let mut fallback: Vec<&str> = vec!["reset", "-q", "HEAD", "--"];
        fallback.extend(paths.iter().map(|s| s.as_str()));
        let out2 = run(root, &fallback)?;
        return check(out2, "unstage");
    }
    Ok(())
}

pub fn discard(root: &Path, path: &str) -> DuckyResult<()> {
    let out = run(root, &["checkout", "--", path])?;
    if out.status != 0 {
        // A file that is untracked has nothing to check out; remove it.
        let full = root.join(path);
        if full.exists() {
            std::fs::remove_file(&full).map_err(|e| DuckyError::Git(e.to_string()))?;
        }
        return Ok(());
    }
    Ok(())
}

pub fn commit(root: &Path, message: &str) -> DuckyResult<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(DuckyError::Git("commit message is empty".into()));
    }
    // `-F -` reads the message from stdin, which avoids both an argument-length
    // limit and any chance of the message being interpreted as a flag.
    use std::io::Write;
    let bin = git_bin().ok_or_else(|| DuckyError::Git("git is not available".into()))?;
    let mut child = Command::new(bin)
        .args(["commit", "--no-verify", "-F", "-"])
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| DuckyError::Git(format!("could not run git: {e}")))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(trimmed.as_bytes())
            .map_err(|e| DuckyError::Git(e.to_string()))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| DuckyError::Git(e.to_string()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(DuckyError::Git(if stderr.is_empty() {
            "commit failed".into()
        } else {
            stderr
        }));
    }
    // `git commit` prints the new hash on stdout; grab it for the UI.
    let head = run(root, &["rev-parse", "--short", "HEAD"])?;
    Ok(head.stdout.trim().to_string())
}

pub fn branches(root: &Path) -> DuckyResult<Vec<(String, bool)>> {
    let out = run(
        root,
        &["for-each-ref", "--format=%(refname:short) %(HEAD)", "refs/heads"],
    )?;
    let mut list = Vec::new();
    for line in out.stdout.lines() {
        let (name, head) = line.trim().split_once(' ').unwrap_or((line.trim(), ""));
        if !name.is_empty() {
            list.push((name.to_string(), head == "*"));
        }
    }
    Ok(list)
}

pub fn current_branch(root: &Path) -> Option<String> {
    run(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|o| o.status == 0)
        .map(|o| o.stdout.trim().to_string())
}

pub fn checkout(root: &Path, branch: &str) -> DuckyResult<()> {
    let out = run(root, &["checkout", branch])?;
    check(out, "checkout")
}

pub fn create_branch(root: &Path, name: &str) -> DuckyResult<()> {
    let out = run(root, &["checkout", "-b", name])?;
    check(out, "create branch")
}

pub fn pull(root: &Path) -> DuckyResult<String> {
    // `check` takes the GitOutput by value, so the text has to be taken first.
    let out = run(root, &["pull", "--no-rebase"])?;
    let text = out.stdout.clone();
    check(out, "pull")?;
    Ok(text)
}

pub fn push(root: &Path) -> DuckyResult<String> {
    let out = run(root, &["push"])?;
    let text = out.stdout.clone();
    check(out, "push")?;
    Ok(text)
}

pub fn init(root: &Path) -> DuckyResult<()> {
    let out = run(root, &["init"])?;
    check(out, "init")
}

pub fn log(root: &Path, limit: u32) -> DuckyResult<Vec<CommitInfo>> {
    // A bounded, fixed-width format: we never buffer an entire history.
    let format = "%h\x1f%an\x1f%ar\x1f%s";
    let limit_arg = format!("-{limit}");
    let out = run(
        root,
        &["log", &limit_arg, &format!("--pretty=format:{format}")],
    )?;
    let mut commits = Vec::new();
    for line in out.stdout.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 4 {
            continue;
        }
        commits.push(CommitInfo {
            hash: parts[0].to_string(),
            author: parts[1].to_string(),
            relative_date: parts[2].to_string(),
            subject: parts[3].to_string(),
        });
        if commits.len() >= limit as usize {
            break;
        }
    }
    Ok(commits)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub author: String,
    pub relative_date: String,
    pub subject: String,
}

fn check(out: GitOutput, what: &str) -> DuckyResult<()> {
    if out.status == 0 {
        return Ok(());
    }
    let msg = if out.stderr.trim().is_empty() {
        out.stdout.trim().to_string()
    } else {
        out.stderr.trim().to_string()
    };
    // User and path data is fine to surface; only credentials are scrubbed, and
    // git output never contains the API key because git has no knowledge of it.
    Err(DuckyError::Git(if msg.is_empty() {
        format!("git {what} failed")
    } else {
        format!("git {what} failed: {msg}")
    }))
}

pub fn available() -> bool {
    git_bin().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ducky-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q"]).unwrap();
        run(&dir, &["config", "user.email", "t@example.com"]).unwrap();
        run(&dir, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        run(&dir, &["add", "a.txt"]).unwrap();
        run(&dir, &["commit", "-q", "-m", "first"]).unwrap();
        dir
    }

    #[test]
    fn reports_status_and_commits() {
        if !available() {
            eprintln!("git unavailable; skipping");
            return;
        }
        let dir = repo();
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("new.txt"), "x\n").unwrap();

        let s = status(&dir);
        assert!(s.is_repo, "{s:?}");
        assert!(s.branch.is_some());
        assert!(s.entries.iter().any(|e| e.path == "a.txt" && e.status == FileStatus::Modified));
        assert!(s.entries.iter().any(|e| e.path == "new.txt" && e.status == FileStatus::Untracked));

        let d = diff(&dir, "a.txt", false).unwrap();
        assert!(d.patch.contains("-hello"), "{}", d.patch);
        assert!(d.additions >= 1 && d.deletions >= 1, "{d:?}");

        stage(&dir, &["a.txt".to_string(), "new.txt".to_string()]).unwrap();
        let s2 = status(&dir);
        assert!(s2.entries.iter().all(|e| e.staged), "{s2:?}");

        let hash = commit(&dir, "second commit").unwrap();
        assert!(!hash.is_empty());
        assert!(log(&dir, 5).unwrap().len() >= 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_repo_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!("ducky-norepo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = status(&dir);
        assert!(!s.is_repo);
        assert!(s.unavailable_reason.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn branch_line_parsing() {
        let mut s = RepoStatus::default();
        parse_branch_line("## main...origin/main [ahead 2, behind 1]", &mut s);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
        assert!(!s.detached);
    }
}
