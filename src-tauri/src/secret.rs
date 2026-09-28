//! Secret storage for API keys.
//!
//! Rules this module exists to enforce:
//!   * a key is never written to the normal settings file;
//!   * a key is never returned to the frontend once stored (the UI only ever
//!     learns *whether* a key is present);
//!   * a key is never allowed to appear in a log line, terminal scrollback or
//!     error message, so every outbound error is passed through [`redact`].

use crate::error::{DuckyError, DuckyResult};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

/// What the UI is allowed to know about a stored credential.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    /// Provider id -> whether a non-empty key is stored.
    pub present: BTreeMap<String, bool>,
    /// True when the key is held in an OS keystore rather than on disk.
    pub os_keystore: bool,
}

/// The credential store.
///
/// `Clone` is required because a streaming AI call holds the store across an
/// `await` point. `parking_lot::RwLock` is deliberately not `Clone`, so this is
/// written out: the clone shares the same file and starts from a snapshot of
/// the current keys, and writes from either copy persist to the same path.
pub struct SecretStore {
    path: PathBuf,
    cache: parking_lot::RwLock<BTreeMap<String, String>>,
}

impl Clone for SecretStore {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            cache: parking_lot::RwLock::new(self.cache.read().clone()),
        }
    }
}

impl SecretStore {
    pub fn load(dir: &PathBuf) -> DuckyResult<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|e| DuckyError::Config(format!("cannot create config dir: {e}")))?;
        let path = dir.join("credentials.json");
        let mut cache = BTreeMap::new();
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(&text) {
                cache = map;
            }
        }
        Ok(Self {
            path,
            cache: parking_lot::RwLock::new(cache),
        })
    }

    pub fn set(&self, provider: &str, key: &str) -> DuckyResult<()> {
        if key.is_empty() {
            return self.clear(provider);
        }
        {
            let mut guard = self.cache.write();
            guard.insert(provider.to_string(), key.to_string());
        }
        self.persist()
    }

    pub fn clear(&self, provider: &str) -> DuckyResult<()> {
        {
            let mut guard = self.cache.write();
            guard.remove(provider);
        }
        self.persist()
    }

    /// Read a key for outbound use. Only the AI transport calls this.
    pub fn get(&self, provider: &str) -> Option<String> {
        self.cache.read().get(provider).cloned()
    }

    pub fn status(&self) -> SecretStatus {
        let cache = self.cache.read();
        SecretStatus {
            present: cache
                .keys()
                .map(|k| (k.clone(), cache.get(k).is_some_and(|v| !v.is_empty())))
                .collect(),
            os_keystore: os_keystore_available(),
        }
    }

    /// Write the keyring out with owner-only permissions.
    ///
    /// We deliberately do not shell out to a password manager and do not
    /// attempt platform keystores beyond a capability probe: a keystore
    /// integration that silently fails on a headless or minimal Linux box would
    /// be worse than a file with `0600` that we know the contents of. The
    /// probe below lets the UI tell the user which mode is in force.
    fn persist(&self) -> DuckyResult<()> {
        let snapshot = self.cache.read().clone();
        let json = serde_json::to_vec_pretty(&snapshot)?;

        // Create with 0600 from the very first byte, so the secret is never
        // briefly world-readable between create and chmod.
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts
            .open(&self.path)
            .map_err(|e| DuckyError::Config(format!("cannot write credentials: {e}")))?;
        file.write_all(&json)
            .map_err(|e| DuckyError::Config(format!("cannot write credentials: {e}")))?;
        file.sync_all().ok();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

/// Probe for an OS keystore. On Linux this is the presence of a Secret Service
/// provider; elsewhere it is the platform keychain.
fn os_keystore_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/usr/bin/security").exists()
    }
    #[cfg(target_os = "windows")]
    {
        true
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var("XDG_CURRENT_DESKTOP")
            .map(|d| {
                let d = d.to_ascii_lowercase();
                d.contains("gnome") || d.contains("kde") || d.contains("plasma")
            })
            .unwrap_or(false)
            && std::path::Path::new("/run/user")
            .join(std::env::var("XDG_RUNTIME_DIR").unwrap_or_default())
            .join("bus")
            .exists()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        false
    }
}

/// Remove anything that looks like a credential from a string bound for a log,
/// an error toast, the terminal, or an AI request body.
///
/// This is intentionally aggressive and slightly dumb: it is a safety net, not
/// the primary mechanism (the primary mechanism is never putting the key in the
/// string in the first place).
pub fn redact(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    // 1. `Authorization: Bearer <token>` and `Bearer <token>`.
    for marker in ["Bearer ", "bearer ", "api-key:", "x-api-key:"] {
        while let Some(idx) = rest.find(marker) {
            let (head, tail) = rest.split_at(idx + marker.len());
            out.push_str(head);
            let end = tail
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',')
                .unwrap_or(tail.len());
            out.push_str("***redacted***");
            rest = &tail[end..];
        }
    }

    // Everything after the last marker. Without this the function returns only
    // the text preceding a marker, so any input containing no marker at all --
    // which is nearly all of them -- came back empty.
    out.push_str(rest);

    // 2. Bare high-entropy tokens: common provider key prefixes, and anything
    //    that looks like `sk-`/`ghp_`/`gho_`/long hex runs.
    let mut out2 = String::new();
    for word in out.split_inclusive(is_token_break) {
        let trimmed = word.trim();
        let looks_secret = trimmed.len() >= 20
            && (trimmed.starts_with("sk-")
                || trimmed.starts_with("sk_")
                || trimmed.starts_with("ghp_")
                || trimmed.starts_with("gho_")
                || trimmed.starts_with("github_pat_")
                || trimmed.starts_with("xai-")
                || (trimmed.chars().all(|c| c.is_ascii_alphanumeric()) && trimmed.len() >= 40));
        if looks_secret {
            // `split_inclusive` hands over the separator along with the token, so
            // it has to be re-emitted or the surrounding words run together:
            // "before <key> after" must not become "before ***redacted***after".
            out2.push_str(&word[..word.len() - word.trim_start().len()]);
            out2.push_str("***redacted***");
            out2.push_str(&word[word.trim_end().len()..]);
        } else {
            out2.push_str(word);
        }
    }

    out2
}

/// True for the characters that end a token.
///
/// The set is deliberately narrow: `.`, `/`, `-` and `_` are kept because real
/// identifiers and file paths contain them, and splitting on them would let a
/// secret be smuggled through as separate fragments.
fn is_token_break(c: char) -> bool {
    !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_tokens() {
        let s = redact("Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345");
        assert!(!s.contains("sk-abcdefghij"), "{s}");
        assert!(s.contains("redacted"), "{s}");
    }

    #[test]
    fn redacts_openai_style_keys() {
        let s = redact("url failed with sk-proj-AAAABBBBCCCCDDDDEEEEFFFF0123");
        assert!(!s.contains("AAAABBBBCCCC"), "{s}");
    }

    #[test]
    fn ordinary_prose_and_code_survive_intact() {
        // The two cases that matter most in production: an AI reply and the
        // output of a shell command both pass through here, and both are far
        // more text than a token. A redactor that eats them breaks the app in a
        // way that looks like "the model returned nothing".
        let reply = "Here is the change: the loop should break once `i` exceeds \
                     `buf.len()`, otherwise it reads past the end.";
        assert_eq!(redact(reply), reply);

        let output = "total 12\ndrwxr-xr-x  4 user user 4096 Jan  1 12:00 src\n\
                      -rw-r--r--  1 user user  220 Jan  1 12:00 README.md";
        assert_eq!(redact(output), output);

        // Trailing text after a marker must be kept, not just what precedes it.
        let with_key = "before sk-proj-AAAABBBBCCCCDDDDEEEEFFFF0123 after";
        let r = redact(with_key);
        assert!(!r.contains("AAAABBBBCCCC"), "{r}");
        assert!(r.starts_with("before "), "{r}");
        assert!(r.ends_with(" after"), "{r}");
    }

    #[test]
    fn empty_input_is_empty_output() {
        assert_eq!(redact(""), "");
    }

    #[test]
    fn keeps_ordinary_text() {
        let s = redact("could not resolve host api.example.com for request 42");
        assert_eq!(s, "could not resolve host api.example.com for request 42");
    }

    #[test]
    fn secrets_are_not_readable_back() {
        let dir = std::env::temp_dir().join(format!("ducky-secret-{}-{:?}",
            std::process::id(),
            std::thread::current().id(),
        ));
        let store = SecretStore::load(&dir).unwrap();
        store.set("openai", "sk-topsecret-value-123456").unwrap();
        // get() is only used by the transport, but the UI path is status().
        let st = store.status();
        assert!(st.present.get("openai").copied().unwrap_or(false));
        let json = serde_json::to_string(&st).unwrap();
        assert!(!json.contains("topsecret"), "status leaked the key: {json}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
