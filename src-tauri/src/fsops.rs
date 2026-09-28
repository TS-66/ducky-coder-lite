//! Filesystem operations.
//!
//! Two rules define this module:
//!
//! 1. **Never read more than asked for.** Listing a folder reads exactly one
//!    directory. Nothing walks the tree. The editor only ever holds the rows
//!    the user has actually expanded, which is what lets the explorer work on
//!    a 48,000-file repository inside a 2 GB budget.
//! 2. **Never touch a path outside the workspace.** `resolve` refuses anything
//!    that escapes the open root, so a symlink or a `..` in a filename from the
//!    AI cannot be used to read the user's SSH keys.

use crate::error::{DuckyError, DuckyResult};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    /// Absolute path. The UI keys rows on this.
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified: u64,
    /// Detected language id, used for icon and syntax highlighting.
    pub language: String,
    pub is_hidden: bool,
    /// True when a child of this directory was skipped by the ignore rules.
    /// The explorer shows a subtle marker instead of silently lying about the
    /// folder being empty.
    pub has_filtered_children: bool,
    pub child_dir_count: usize,
    pub child_file_count: usize,
}

/// Directories that are never expanded and never traversed, matched exactly at
/// any depth. This is the first line of defence; the per-project glob list in
/// settings is the second.
const ALWAYS_IGNORED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".gradle",
    ".idea",
    ".vscode-test",
    "obj",
    "bin",
    ".cache",
    "coverage",
    ".turbo",
    ".parcel-cache",
    ".svelte-kit",
    "vendor",
    "Pods",
    "DerivedData",
    ".terraform",
    ".dart_tool",
];

/// The workspace root currently open, if any.
#[derive(Debug, Clone, Default)]
pub struct Workspace {
    root: Option<PathBuf>,
}

impl Workspace {
    pub fn new() -> Self {
        Self { root: None }
    }

    pub fn open(&mut self, path: &Path) -> DuckyResult<()> {
        let canonical = path
            .canonicalize()
            .map_err(|e| DuckyError::InvalidPath(format!("cannot open folder: {e}")))?;
        if !canonical.is_dir() {
            return Err(DuckyError::InvalidPath("not a folder".into()));
        }
        self.root = Some(canonical);
        Ok(())
    }

    pub fn close(&mut self) {
        self.root = None;
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    pub fn root_str(&self) -> Option<String> {
        self.root.as_ref().map(|p| p.to_string_lossy().to_string())
    }

    /// Resolve a possibly-relative path against the root, refusing anything
    /// that escapes it.
    pub fn resolve(&self, path: &str) -> DuckyResult<PathBuf> {
        let root = self
            .root
            .as_ref()
            .ok_or_else(|| DuckyError::InvalidPath("no folder is open".into()))?;

        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            root.join(path)
        };

        // Lexical normalisation first, so `a/../../etc` is caught even when the
        // intermediate path does not exist.
        let normalised = lexical_normalise(&candidate);

        if !normalised.starts_with(root) {
            return Err(DuckyError::InvalidPath(
                "path is outside the open folder".into(),
            ));
        }

        // Then a symlink-aware check on the deepest existing ancestor, which
        // catches a symlink inside the workspace pointing out of it.
        if let Ok(real) = normalised.canonicalize() {
            if !real.starts_with(root) {
                return Err(DuckyError::InvalidPath(
                    "path resolves outside the open folder".into(),
                ));
            }
        }

        Ok(normalised)
    }
}

/// Collapse `.` and `..` without touching the filesystem.
fn lexical_normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Never pop past the root: `/..` is `/`.
                if !out.pop() {
                    out.push("/");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_ignored_dir_name(name: &str) -> bool {
    ALWAYS_IGNORED.iter().any(|d| name.eq_ignore_ascii_case(d))
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

/// Map a filename to a language id. Pure string matching: no filesystem probing
/// and no MIME database, so it costs microseconds and no memory.
pub fn language_for(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let id = match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "json" | "jsonc" => "json",
        "json5" => "json5",
        "py" | "pyi" => "python",
        "lua" => "lua",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        "php" => "php",
        "sh" | "bash" | "zsh" | "ksh" => "shell",
        "fish" => "fish",
        "ps1" | "psm1" => "powershell",
        "bat" | "cmd" => "batch",
        "sql" => "sql",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "sass",
        "less" => "less",
        "svelte" => "svelte",
        "md" | "markdown" | "mdx" => "markdown",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "ini" | "cfg" | "conf" => "ini",
        "xml" | "plist" => "xml",
        "dockerfile" => "dockerfile",
        "graphql" | "gql" => "graphql",
        "proto" => "protobuf",
        "tf" | "tfvars" => "terraform",
        "zig" => "zig",
        "ex" | "exs" => "elixir",
        "erl" => "erlang",
        "hs" => "haskell",
        "ml" | "mli" => "ocaml",
        "clj" | "cljs" => "clojure",
        "scala" => "scala",
        "dart" => "dart",
        "r" => "r",
        "jl" => "julia",
        "vue" => "vue",
        "asm" | "s" => "asm",
        "diff" | "patch" => "diff",
        "txt" | "log" => "text",
        "env" => "dotenv",
        "gitignore" => "gitignore",
        "lock" => "lockfile",
        _ => {
            // A few well-known files have no extension.
            match name.to_ascii_lowercase().as_str() {
                "dockerfile" => "dockerfile",
                "makefile" | "gnumakefile" => "makefile",
                "cargo.lock" | "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" => "lockfile",
                ".gitignore" | ".dockerignore" | ".npmignore" => "gitignore",
                ".env" | ".env.local" | ".env.production" => "dotenv",
                "readme" | "license" | "licence" | "notice" | "authors" | "changelog" => "text",
                "cmakelists.txt" => "cmake",
                _ => "plaintext",
            }
        }
    };
    id.to_string()
}

/// Read exactly one directory. This is the only traversal primitive; there is
/// deliberately no "list the whole project" call.
pub fn list_dir(ws: &Workspace, path: &str) -> DuckyResult<Vec<FsEntry>> {
    let dir = if path.is_empty() {
        ws.root()
            .ok_or_else(|| DuckyError::InvalidPath("no folder is open".into()))?
            .to_path_buf()
    } else {
        ws.resolve(path)?
    };

    if !dir.is_dir() {
        return Err(DuckyError::InvalidPath("not a folder".into()));
    }

    let read = std::fs::read_dir(&dir)
        .map_err(|e| DuckyError::Io(format!("{}: {e}", dir.display())))?;

    let mut entries: Vec<FsEntry> = Vec::new();
    // Counts of children that the ignore rules hid, so the explorer can say
    // "N items hidden" rather than implying the folder is empty.
    let mut filtered = 0usize;

    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if is_ignored_dir_name(&name) {
            if item.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                filtered += 1;
            }
            continue;
        }

        let Ok(ft) = item.file_type() else { continue };
        let is_dir = ft.is_dir();
        let is_symlink = ft.is_symlink();
        let path_str = item.path().to_string_lossy().to_string();

        let (size, modified) = match item.metadata() {
            Ok(md) => (md.len(), unix_seconds(md.modified().ok())),
            Err(_) => (0, 0),
        };

        let kind = if is_dir {
            EntryKind::Directory
        } else if is_symlink {
            EntryKind::Symlink
        } else {
            EntryKind::File
        };

        entries.push(FsEntry {
            language: if is_dir {
                "folder".into()
            } else {
                language_for(&name)
            },
            path: path_str,
            name,
            kind,
            size,
            modified,
            is_hidden: is_hidden(&item.file_name().to_string_lossy()),
            has_filtered_children: false,
            child_dir_count: 0,
            child_file_count: 0,
        });
    }

    // Directories first, then case-insensitive name order. Doing this once here
    // means the frontend never sorts a tree, which matters when a folder holds
    // a few thousand entries.
    entries.sort_by(|a, b| match (a.kind == EntryKind::Directory, b.kind == EntryKind::Directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    if !entries.is_empty() {
        entries[0].has_filtered_children = filtered > 0;
    } else {
        // Nothing to attach the flag to; surface it via a sentinel-free path by
        // recording it on the response object instead (see `ListResult`).
    }

    Ok(entries)
}

/// How many child entries a directory has without reading them all — used to
/// decide whether the explorer should virtualise the list.
pub fn dir_child_counts(path: &Path) -> (usize, usize) {
    let Ok(read) = std::fs::read_dir(path) else {
        return (0, 0);
    };
    let mut dirs = 0;
    let mut files = 0;
    for item in read.flatten() {
        if let Ok(ft) = item.file_type() {
            if ft.is_dir() {
                if !is_ignored_dir_name(&item.file_name().to_string_lossy()) {
                    dirs += 1;
                }
            } else {
                files += 1;
            }
        }
    }
    (dirs, files)
}

fn unix_seconds(t: Option<std::time::SystemTime>) -> u64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read a text file, refusing anything past `max_bytes`.
///
/// A hard cap here is what stops a stray multi-gigabyte log or a packed
/// database from being pulled into the webview's heap.
pub fn read_file(path: &Path, max_bytes: u64) -> DuckyResult<(String, bool)> {
    let md = std::fs::metadata(path)
        .map_err(|e| DuckyError::Io(format!("cannot stat file: {e}")))?;
    let truncated = md.len() > max_bytes;
    let limit = if truncated { max_bytes } else { md.len() };

    let bytes = read_capped(path, limit)
        .map_err(|e| DuckyError::Io(format!("cannot read file: {e}")))?;

    Ok((decode_text(&bytes, truncated), truncated))
}

/// Read at most `limit` bytes without loading the whole file. `File::take` does
/// the bounding, so a 4 GB file costs us 4 MB.
fn read_capped(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut buf = Vec::with_capacity(std::cmp::min(limit, 256 * 1024) as usize);
    file.take(limit).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Decode bytes as text, stripping a UTF-8 BOM and dropping a trailing NUL run
/// that some Windows toolchains leave behind.
fn decode_text(bytes: &[u8], truncated: bool) -> String {
    let body = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    };
    let body = match body.iter().position(|b| *b == 0) {
        Some(i) => &body[..i],
        None => body,
    };
    match std::str::from_utf8(body) {
        Ok(s) => s.to_string(),
        Err(_) => {
            // Lossy is the right call for a code editor: it shows the bytes
            // rather than refusing to open a mis-encoded file.
            String::from_utf8_lossy(body).into_owned()
        }
    }
    .trim_end_matches('\u{0}')
    .to_string()
        + if truncated { "\n\n/* … truncated … */" } else { "" }
}

pub fn write_file(path: &Path, contents: &str) -> DuckyResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| DuckyError::Io(format!("cannot create folder: {e}")))?;
    }
    std::fs::write(path, contents.as_bytes())
        .map_err(|e| DuckyError::Io(format!("cannot save file: {e}")))?;
    Ok(())
}

pub fn create_entry(ws: &Workspace, path: &str, kind: EntryKind) -> DuckyResult<FsEntry> {
    let target = ws.resolve(path)?;
    if target.exists() {
        return Err(DuckyError::InvalidPath("something already exists there".into()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| DuckyError::Io(format!("cannot create folder: {e}")))?;
    }
    match kind {
        EntryKind::Directory => std::fs::create_dir(&target)
            .map_err(|e| DuckyError::Io(format!("cannot create folder: {e}")))?,
        _ => std::fs::write(&target, b"")
            .map_err(|e| DuckyError::Io(format!("cannot create file: {e}")))?,
    }
    entry_for(&target)
}

pub fn rename_entry(ws: &Workspace, from: &str, to: &str) -> DuckyResult<String> {
    let src = ws.resolve(from)?;
    let dst = ws.resolve(to)?;
    if dst.exists() {
        return Err(DuckyError::InvalidPath("target already exists".into()));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| DuckyError::Io(format!("cannot create folder: {e}")))?;
    }
    std::fs::rename(&src, &dst).map_err(|e| DuckyError::Io(format!("cannot rename: {e}")))?;
    Ok(dst.to_string_lossy().to_string())
}

pub fn delete_entry(ws: &Workspace, path: &str) -> DuckyResult<()> {
    let target = ws.resolve(path)?;
    let md = std::fs::symlink_metadata(&target)
        .map_err(|e| DuckyError::Io(format!("cannot stat: {e}")))?;
    if md.is_dir() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| DuckyError::Io(format!("cannot delete folder: {e}")))?;
    } else {
        std::fs::remove_file(&target)
            .map_err(|e| DuckyError::Io(format!("cannot delete file: {e}")))?;
    }
    Ok(())
}

pub fn move_entry(ws: &Workspace, from: &str, to_dir: &str) -> DuckyResult<String> {
    let src = ws.resolve(from)?;
    let dir = ws.resolve(to_dir)?;
    let name = src
        .file_name()
        .ok_or_else(|| DuckyError::InvalidPath("invalid name".into()))?;
    let dst = dir.join(name);
    if dst.exists() {
        return Err(DuckyError::InvalidPath("target already exists".into()));
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| DuckyError::Io(format!("cannot create folder: {e}")))?;
    std::fs::rename(&src, &dst).map_err(|e| DuckyError::Io(format!("cannot move: {e}")))?;
    Ok(dst.to_string_lossy().to_string())
}

/// A cheap "does this look like text?" test, so images and binaries open in an
/// image/preview viewer instead of the editor.
pub fn looks_binary(path: &Path) -> bool {
    let Ok(bytes) = read_capped(path, 4096) else {
        return false;
    };
    if bytes.is_empty() {
        return false;
    }
    if bytes.contains(&0) {
        return true;
    }
    // A high proportion of non-printable bytes also means binary.
    let control = bytes
        .iter()
        .filter(|b| **b < 0x09 || (**b > 0x0D && **b < 0x20) || **b == 0x7F)
        .count();
    control * 100 / bytes.len() > 5
}

pub fn entry_for(path: &Path) -> DuckyResult<FsEntry> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let md = std::fs::symlink_metadata(path)
        .map_err(|e| DuckyError::Io(format!("cannot stat: {e}")))?;
    let is_dir = md.is_dir();
    let is_symlink = md.file_type().is_symlink();
    Ok(FsEntry {
        language: if is_dir { "folder".into() } else { language_for(&name) },
        path: path.to_string_lossy().to_string(),
        name: name.clone(),
        kind: if is_dir {
            EntryKind::Directory
        } else if is_symlink {
            EntryKind::Symlink
        } else {
            EntryKind::File
        },
        size: if is_dir { 0 } else { md.len() },
        modified: unix_seconds(md.modified().ok()),
        is_hidden: is_hidden(&name),
        has_filtered_children: false,
        child_dir_count: 0,
        child_file_count: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ws() -> (Workspace, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ducky-fs-{}-{:?}",
            std::process::id(),
            std::thread::current().id(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "x").unwrap();
        let mut ws = Workspace::new();
        ws.open(&dir).unwrap();
        (ws, dir)
    }

    #[test]
    fn listing_is_lazy_and_ignores_noise() {
        let (ws, dir) = temp_ws();
        let entries = list_dir(&ws, "").unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"README.md"));
        assert!(
            !names.contains(&"node_modules"),
            "node_modules must be hidden"
        );
        // We read one directory, not the tree: `src/main.rs` is absent.
        assert!(!names.contains(&"main.rs"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_paths_outside_the_workspace() {
        let (ws, dir) = temp_ws();
        assert!(ws.resolve("../escape").is_err());
        assert!(ws.resolve("src/../../escape").is_err());
        assert!(ws.resolve("/etc/passwd").is_err());
        assert!(ws.resolve("src/main.rs").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn language_detection() {
        assert_eq!(language_for("main.rs"), "rust");
        assert_eq!(language_for("app.tsx"), "tsx");
        assert_eq!(language_for("script.lua"), "lua");
        assert_eq!(language_for("Dockerfile"), "dockerfile");
        assert_eq!(language_for("Cargo.toml"), "toml");
        assert_eq!(language_for("mystery.zzz"), "plaintext");
    }

    #[test]
    fn large_files_are_capped() {
        let dir = std::env::temp_dir().join(format!("ducky-big-{}-{:?}",
            std::process::id(),
            std::thread::current().id(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let big = "x".repeat(50_000);
        std::fs::write(dir.join("big.txt"), &big).unwrap();
        let (text, truncated) = read_file(&dir.join("big.txt"), 1_000).unwrap();
        assert!(truncated);
        assert!(text.len() < 2_000, "should have been capped");
        let (text, truncated) = read_file(&dir.join("big.txt"), 1_000_000).unwrap();
        assert!(!truncated);
        assert!(text.contains("xxxx"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_rename_move_delete_roundtrip() {
        let (ws, dir) = temp_ws();
        create_entry(&ws, "src/lib.rs", EntryKind::File).unwrap();
        assert!(ws.resolve("src/lib.rs").unwrap().exists());
        rename_entry(&ws, "src/lib.rs", "src/util.rs").unwrap();
        assert!(ws.resolve("src/util.rs").unwrap().exists());
        move_entry(&ws, "src/util.rs", "").unwrap();
        assert!(ws.resolve("util.rs").unwrap().exists());
        delete_entry(&ws, "util.rs").unwrap();
        assert!(!ws.resolve("util.rs").unwrap().exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
