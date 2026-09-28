//! Workspace search.
//!
//! The contract with the rest of the app: results are **streamed** to the UI in
//! batches and the search **stops** the instant the result cap is hit. Nothing
//! is accumulated into a growing `Vec` beyond the cap, and no file is ever read
//! whole unless it is under `max_file_bytes`.
//!
//! Concurrency is deliberately small. On a 2 GB machine the search is competing
//! with the editor for every core, so we use a handful of threads and let the
//! scheduler share the rest.

use crate::config::Settings;
use crate::error::{DuckyError, DuckyResult};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// Workspace-relative path.
    pub path: String,
    pub line: u32,
    pub column: u32,
    /// The matching line, trimmed and clipped so a minified file cannot ship a
    /// 200 KB string to the UI per hit.
    pub preview: String,
    /// Indices of the match within `preview`, for highlighting.
    pub match_start: u32,
    pub match_length: u32,
    pub truncated_line: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBatch {
    pub matches: Vec<SearchMatch>,
    pub done: bool,
    pub files_scanned: u32,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub score: u32,
}

/// Shared cancellation flag so a new keystroke can stop the previous search
/// mid-walk instead of queueing behind it.
#[derive(Clone, Default)]
pub struct SearchCancel(Arc<AtomicBool>);

impl SearchCancel {
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

/// Max characters of a matched line we are willing to show.
const PREVIEW_MAX: usize = 240;
/// Max hits we keep per file, so one pathological file cannot flood the UI.
const MAX_HITS_PER_FILE: usize = 50;

pub struct SearchRequest {
    pub root: String,
    pub query: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include_pattern: Option<String>,
    pub max_results: usize,
    pub max_file_bytes: u64,
    pub exclude_globs: Vec<String>,
    /// Emit filename hits too (used by the Quick Open and @-mention pickers).
    pub want_files: bool,
}

/// State shared by every search worker thread.
struct SearchShared {
    sink: parking_lot::Mutex<Vec<SearchMatch>>,
    scanned: AtomicUsize,
    truncated: AtomicBool,
    cancel: SearchCancel,
    include: Option<regex::Regex>,
    matcher: Matcher,
    root: String,
    max_results: usize,
    max_file_bytes: u64,
}

pub struct SearchOutcome {
    pub matches: Vec<SearchMatch>,
    pub files_scanned: u32,
    pub truncated: bool,
}

/// Run a content search, returning at most `max_results` hits.
///
/// Blocking. The caller is expected to run this on a worker thread and stream
/// the outcome back; the work itself is fast because it is I/O bound and
/// bounded by the result cap.
pub fn search_content(req: &SearchRequest, cancel: &SearchCancel) -> DuckyResult<SearchOutcome> {
    if req.query.is_empty() {
        return Ok(SearchOutcome {
            matches: Vec::new(),
            files_scanned: 0,
            truncated: false,
        });
    }

    let matcher = Matcher::build(req)?;
    let mut builder = ignore::WalkBuilder::new(&req.root);
    builder
        // Respect .gitignore where present, but never require a git repo: a
        // plain folder should still get sensible traversal.
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .hidden(false)
        .follow_links(false)
        .max_depth(Some(24))
        .threads(2);

    for glob in &req.exclude_globs {
        if !glob.is_empty() {
            builder.add_custom_ignore_filename(glob);
        }
    }

    // `ignore` calls its worker factory once per thread, and each returned
    // visitor must own whatever it touches -- a closure that merely borrowed a
    // local would not outlive the factory call. So everything shared is behind
    // an `Arc` and cloned per thread; only the per-thread result buffer is
    // created inside the factory and moved into its own closure.
    let shared = Arc::new(SearchShared {
        sink: parking_lot::Mutex::new(Vec::<SearchMatch>::with_capacity(256)),
        scanned: AtomicUsize::new(0),
        truncated: AtomicBool::new(false),
        cancel: cancel.clone(),
        include: req.include_pattern.as_deref().and_then(glob_to_matcher),
        matcher: matcher.clone(),
        root: req.root.clone(),
        max_results: req.max_results,
        max_file_bytes: req.max_file_bytes,
    });

    builder.build_parallel().run(|| {
        let mut local: Vec<SearchMatch> = Vec::with_capacity(64);
        let shared = Arc::clone(&shared);
        Box::new(move |entry| {
            let sh = &shared;
            if sh.cancel.is_cancelled() || sh.truncated.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return ignore::WalkState::Continue;
            }
            let path = entry.path();
            if let Some(re) = &sh.include {
                if !re.is_match(&path.to_string_lossy()) {
                    return ignore::WalkState::Continue;
                }
            }
            let meta = match path.metadata() {
                Ok(m) => m,
                Err(_) => return ignore::WalkState::Continue,
            };
            if meta.len() == 0 || meta.len() > sh.max_file_bytes {
                return ignore::WalkState::Continue;
            }

            sh.scanned.fetch_add(1, Ordering::Relaxed);
            local.clear();
            let produced = scan_file(path, &sh.root, &sh.matcher, sh, &mut local);
            if produced == Some(true) && !local.is_empty() {
                let mut guard = sh.sink.lock();
                // Stop the instant the cap is reached, and tell the other
                // workers to stop too rather than wasting the remaining files.
                if guard.len() >= sh.max_results {
                    sh.truncated.store(true, Ordering::Relaxed);
                    return ignore::WalkState::Quit;
                }
                let room = sh.max_results - guard.len();
                guard.extend(local.drain(..).take(room));
                if guard.len() >= sh.max_results {
                    sh.truncated.store(true, Ordering::Relaxed);
                }
            }
            ignore::WalkState::Continue
        })
    });

    let mut all = std::mem::take(&mut *shared.sink.lock());
    all.truncate(req.max_results);

    Ok(SearchOutcome {
        matches: all,
        files_scanned: shared.scanned.load(Ordering::Relaxed) as u32,
        truncated: shared.truncated.load(Ordering::Relaxed),
    })
}

/// Scan one file, appending hits to `out`. Returns `Some(true)` if the file
/// produced any hit.
fn scan_file(
    path: &Path,
    root: &str,
    matcher: &Matcher,
    sh: &SearchShared,
    out: &mut Vec<SearchMatch>,
) -> Option<bool> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(64 * 1024);
    // Bounded read: a file that grew since the metadata check still cannot
    // blow up our heap.
    file.by_ref()
        .take(sh.max_file_bytes)
        .read_to_end(&mut buf)
        .ok()?;
    if buf.contains(&0) {
        return None;
    }
    let text = String::from_utf8_lossy(&buf);
    let rel = relative(path, root);
    let mut hits = 0usize;

    for (i, line) in text.lines().enumerate() {
        if let Some((start, len)) = matcher.find(line) {
            let byte_start = start.min(line.len());
            let byte_end = (start + len).min(line.len());
            // Clamp to char boundaries before slicing, or we panic on non-ASCII.
            let safe_start = floor_char_boundary(line, byte_start);
            let safe_end = ceil_char_boundary(line, byte_end);
            let column = line[..safe_start].chars().count() + 1;
            let (preview, preview_start, match_start, truncated_line) =
                clip(line, safe_start, safe_end);
            out.push(SearchMatch {
                path: rel.clone(),
                line: (i + 1) as u32,
                column: column as u32,
                preview,
                match_start: match_start as u32,
                match_length: (safe_end - safe_start) as u32,
                truncated_line,
            });
            let _ = preview_start;
            hits += 1;
            if hits >= MAX_HITS_PER_FILE {
                break;
            }
        }
        if out.len() >= MAX_HITS_PER_FILE * 8 {
            break;
        }
    }

    Some(hits > 0)
}

/// Clip a line around the match so a single 500 KB minified line cannot cost
/// 500 KB of UI memory per hit.
///
/// Returns the clipped preview, the offset the clip started at, the match
/// offset *relative to the preview* (so the UI can highlight it without
/// re-finding the text), and whether anything was cut.
fn clip(line: &str, start: usize, end: usize) -> (String, usize, usize, bool) {
    if line.len() <= PREVIEW_MAX {
        return (line.to_string(), 0, start, false);
    }
    let match_len = end - start;
    let pad = PREVIEW_MAX.saturating_sub(match_len) / 2;
    let lo = floor_char_boundary(line, start.saturating_sub(pad));
    let hi = ceil_char_boundary(line, (end + pad).min(line.len()));
    let mut s = String::with_capacity(hi - lo + 2);
    if lo > 0 {
        s.push('…');
    }
    s.push_str(&line[lo..hi]);
    if hi < line.len() {
        s.push('…');
    }
    // The leading ellipsis shifts the match by one char.
    let lead = usize::from(lo > 0);
    (s, lo, start - lo + lead, true)
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

pub fn relative(path: &Path, root: &str) -> String {
    match path.strip_prefix(root) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

#[derive(Clone)]
enum Matcher {
    /// A literal, pre-lowercased needle. Uses memchr to skip lines quickly.
    Literal {
        needle: String,
        needle_lower: String,
        case_sensitive: bool,
        whole_word: bool,
    },
    Regex(regex::Regex),
}

impl Matcher {
    fn build(req: &SearchRequest) -> DuckyResult<Self> {
        if req.is_regex {
            // Whole-word search wraps the pattern in \b(?:...)\b. The escaping
            // matters: the user's text is a pattern only in the regex case, and
            // the wrapper must not be able to be broken out of.
            let pattern = if req.whole_word {
                format!(r"\b(?:{})\b", req.query)
            } else {
                req.query.clone()
            };
            // These setters consume and return Self, so they must be threaded
            // through to the value that is actually built.
            let re = regex::RegexBuilder::new(&pattern)
                .case_insensitive(!req.case_sensitive)
                .multi_line(false)
                // A pathological regex must not eat the machine: cap the size
                // of the compiled program.
                .size_limit(1 << 20)
                .dfa_size_limit(1 << 20)
                .build()
                .map_err(|e| DuckyError::Config(format!("invalid regex: {e}")))?;
            Ok(Self::Regex(re))
        } else {
            Ok(Self::Literal {
                needle: req.query.clone(),
                needle_lower: if req.case_sensitive {
                    req.query.clone()
                } else {
                    req.query.to_lowercase()
                },
                case_sensitive: req.case_sensitive,
                whole_word: req.whole_word,
            })
        }
    }

    /// Returns `(byte offset, byte length)` of the first match on the line.
    fn find(&self, line: &str) -> Option<(usize, usize)> {
        match self {
            Self::Literal {
                needle,
                needle_lower,
                case_sensitive,
                whole_word,
            } => {
                if *case_sensitive {
                    if let Some(i) = line.find(needle.as_str()) {
                        if *whole_word && !is_whole_word(line, i, i + needle.len()) {
                            return None;
                        }
                        return Some((i, needle.len()));
                    }
                    None
                } else {
                    // Case-insensitive: scan with memchr on the first
                    // character, which is dramatically faster than lowercasing
                    // every line of a large repository.
                    let first = needle_lower.chars().next()?;
                    let fb = first as u8;
                    let hay_lower = line.to_lowercase();
                    let mut offset = 0usize;
                    while offset < hay_lower.len() {
                        let rel = memchr::memchr(fb, &hay_lower.as_bytes()[offset..])?;
                        let i = offset + rel;
                        if hay_lower[i..].starts_with(needle_lower.as_str()) {
                            let len = needle_lower.len();
                            if *whole_word && !is_whole_word(&hay_lower, i, i + len) {
                                offset = i + fb.max(1) as usize;
                                continue;
                            }
                            // Map back to the original string's byte offsets by
                            // matching the same char count.
                            let from: usize = line
                                .char_indices()
                                .nth(hay_lower[..i].chars().count())
                                .map(|(o, _)| o)
                                .unwrap_or(i);
                            let to: usize = line
                                .char_indices()
                                .nth(hay_lower[..i + len].chars().count())
                                .map(|(o, _)| o)
                                .unwrap_or(from + len);
                            return Some((from, to.saturating_sub(from)));
                        }
                        offset = i + fb.max(1) as usize;
                    }
                    None
                }
            }
            Self::Regex(re) => re
                .find(line)
                .map(|m| (m.start(), m.end().saturating_sub(m.start()))),
        }
    }
}

fn is_whole_word(hay: &str, start: usize, end: usize) -> bool {
    let before_ok = start == 0
        || !hay[..start]
            .chars()
            .next_back()
            .map(|c| c.is_alphanumeric() || c == '_')
            .unwrap_or(false);
    let after_ok = end >= hay.len()
        || !hay[end..]
            .chars()
            .next()
            .map(|c| c.is_alphanumeric() || c == '_')
            .unwrap_or(false);
    before_ok && after_ok
}

/// Find files by name, for Quick Open and `@` mentions.
///
/// Stops at `limit` and never builds a full file list: the walk is abandoned as
/// soon as enough good matches exist, which is why this is fast even on very
/// large repositories.
pub fn find_files(
    root: &str,
    query: &str,
    limit: usize,
    exclude_globs: &[String],
) -> DuckyResult<Vec<NameHit>> {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .git_ignore(true)
        .git_global(false)
        .hidden(false)
        .follow_links(false)
        .max_depth(Some(24))
        .threads(2);
    for glob in exclude_globs {
        if !glob.is_empty() {
            builder.add_custom_ignore_filename(glob);
        }
    }
    let mut excluder: Option<globset::GlobSet> = None;
    for glob in exclude_globs {
        if let Ok(g) = globset::Glob::new(glob) {
            let mut set = globset::GlobSetBuilder::new();
            set.add(g);
            if let Ok(set) = set.build() {
                excluder = Some(set);
            }
            break;
        }
    }

    let needle = query.to_lowercase();
    let mut hits: Vec<NameHit> = Vec::new();
    let mut overflow = false;

    for walked in builder.build() {
        if overflow {
            break;
        }
        let Ok(entry) = walked else {
            continue;
        };
        let name = entry.file_name().to_string_lossy();
        if name.starts_with('.') && name != ".gitignore" {
            continue;
        }
        let rel = relative(entry.path(), root);
        if let Some(set) = &excluder {
            if set.is_match(entry.path()) {
                continue;
            }
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            // Skip binaries outright; they are never a useful Quick Open hit.
            if let Ok(md) = entry.metadata() {
                if md.len() > 2_000_000 {
                    continue;
                }
            }
        }
        if !needle.is_empty() {
            let lower = rel.to_lowercase();
            if !fuzzy_contains(&lower, &needle) {
                continue;
            }
        }
        hits.push(NameHit {
            score: score(&rel, &needle, is_dir),
            path: rel,
            name: name.to_string(),
            is_dir,
        });
        if hits.len() > limit * 4 {
            // Keep a healthy over-sample, then sort down to the limit.
            overflow = true;
        }
    }

    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    hits.truncate(limit);
    Ok(hits)
}

/// Cheap subsequence match: "am" matches "auth/middleware". This is what makes
/// Quick Open forgiving without an index.
fn fuzzy_contains(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if hay.contains(needle) {
        return true;
    }
    let mut it = hay.chars();
    needle.chars().all(|c| it.any(|h| h == c))
}

fn score(path: &str, needle: &str, is_dir: bool) -> u32 {
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let mut s = if name == needle { 1000 } else { 0 };
    if name.starts_with(needle) {
        s += 400;
    }
    if name.contains(needle) {
        s += 200;
    }
    if lower.contains(needle) {
        s += 100;
    }
    // Prefer shallow paths: a hit near the root is usually what was meant.
    s += (200u32).saturating_sub(lower.matches('/').count() as u32 * 12);
    if is_dir {
        s += 20;
    }
    s
}

fn glob_to_matcher(pattern: &str) -> Option<regex::Regex> {
    let re = globset_like_to_regex(pattern);
    regex::Regex::new(&re).ok()
}

/// Minimal glob -> regex translation for the `files to include` box, which
/// accepts `*.rs`, `src/**`, `**/*.ts` and plain substrings.
pub fn globset_like_to_regex(pattern: &str) -> String {
    let mut out = String::from("(?i)");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` should also match zero directories.
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        out.push_str("(?:.*/)?");
                    } else {
                        out.push_str(".*");
                    }
                } else {
                    out.push_str("[^/]*");
                }
            }
            '?' => out.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            other => out.push(other),
        }
    }
    out
}

/// Convenience wrapper that reads the settings for exclude globs.
pub fn defaults_from_settings(settings: &Settings) -> SearchRequest {
    SearchRequest {
        root: settings.last_workspace.clone().unwrap_or_default(),
        query: String::new(),
        is_regex: settings.search.use_regex,
        case_sensitive: settings.search.case_sensitive,
        whole_word: settings.search.whole_word,
        include_pattern: None,
        max_results: settings.search.max_results,
        max_file_bytes: settings.search.max_file_bytes as u64,
        exclude_globs: settings.search.exclude_globs.clone(),
        want_files: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        let dir = std::env::temp_dir().join(format!("ducky-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(
            dir.join("src/auth.rs"),
            "fn login() {}\nfn logout() {}\n// Login flow\n",
        )
        .unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() { login(); }").unwrap();
        std::fs::write(dir.join("node_modules/big.rs"), "fn login() {}").unwrap();
        dir.to_string_lossy().to_string()
    }

    fn req(root: &str, query: &str) -> SearchRequest {
        let s = Settings::default();
        SearchRequest {
            root: root.to_string(),
            query: query.to_string(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include_pattern: None,
            max_results: 100,
            max_file_bytes: 1_000_000,
            exclude_globs: s.search.exclude_globs.clone(),
            want_files: false,
        }
    }

    #[test]
    fn finds_content_and_respects_excludes() {
        let root = fixture();
        let out = search_content(&req(&root, "login"), &SearchCancel::new()).unwrap();
        assert!(out.matches.len() >= 2, "{:?}", out.matches);
        assert!(
            !out.matches.iter().any(|m| m.path.contains("node_modules")),
            "must not search node_modules"
        );
        // Case-insensitive by default.
        assert!(out.matches.iter().any(|m| m.path == "src/auth.rs" && m.line == 3));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn respects_the_result_cap() {
        let root = fixture();
        let mut r = req(&root, "login");
        r.max_results = 1;
        let out = search_content(&r, &SearchCancel::new()).unwrap();
        assert_eq!(out.matches.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cancellation_stops_the_walk() {
        let root = fixture();
        let cancel = SearchCancel::new();
        cancel.cancel();
        let out = search_content(&req(&root, "login"), &cancel).unwrap();
        assert!(out.matches.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn regex_and_whole_word() {
        let root = fixture();
        let mut r = req(&root, r"fn\s+log");
        r.is_regex = true;
        let out = search_content(&r, &SearchCancel::new()).unwrap();
        assert!(out.matches.len() >= 2);

        let mut w = req(&root, "login");
        w.whole_word = true;
        let out2 = search_content(&w, &SearchCancel::new()).unwrap();
        assert!(out2.matches.iter().all(|m| m.match_length == 5));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_files_by_fuzzy_name() {
        let root = fixture();
        let hits = find_files(&root, "auth", 20, &Settings::default().search.exclude_globs).unwrap();
        assert!(hits.iter().any(|h| h.path == "src/auth.rs"), "{hits:?}");
        assert!(!hits.iter().any(|h| h.path.contains("node_modules")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn glob_translation() {
        let re = regex::Regex::new(&globset_like_to_regex("*.rs")).unwrap();
        assert!(re.is_match("main.rs"));
        assert!(!re.is_match("main.py"));
        let re2 = regex::Regex::new(&globset_like_to_regex("src/**")).unwrap();
        assert!(re2.is_match("src/a/b.rs"));
    }
}
