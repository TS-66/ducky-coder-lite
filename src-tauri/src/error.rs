//! A single error type for the whole backend, serialisable straight to the
//! frontend. Keeping one enum means the UI never has to guess at string
//! shapes, and it guarantees no command can accidentally return a `Debug`
//! dump that might contain a key or a path we did not mean to leak.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum DuckyError {
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    InvalidPath(String),
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    Network(String),
    #[error("{0}")]
    Config(String),
    #[error("{0}")]
    Terminal(String),
    #[error("{0}")]
    Ai(String),
    #[error("cancelled")]
    Cancelled,
    #[error("out of memory: {0}")]
    OutOfMemory(String),
    #[error("{0}")]
    Other(String),
}

impl DuckyError {
    /// Stable machine-readable tag, so the frontend can branch on the kind of
    /// failure without string matching.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::InvalidPath(_) => "invalidPath",
            Self::Git(_) => "git",
            Self::Network(_) => "network",
            Self::Config(_) => "config",
            Self::Terminal(_) => "terminal",
            Self::Ai(_) => "ai",
            Self::Cancelled => "cancelled",
            Self::OutOfMemory(_) => "outOfMemory",
            Self::Other(_) => "other",
        }
    }
}

impl Serialize for DuckyError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("DuckyError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type DuckyResult<T> = Result<T, DuckyError>;

impl From<std::io::Error> for DuckyError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<serde_json::Error> for DuckyError {
    fn from(e: serde_json::Error) -> Self {
        Self::Config(e.to_string())
    }
}
