use std::collections::BTreeMap;

/// The server's own default port (`DEFAULT_PORT`, shared/protocol.ts).
const DEFAULT_PORT: &str = "7317";
const LOOPBACK: &str = "127.0.0.1";

/// Where the local Ovis server answers, and the token it asks for.
#[derive(Clone, PartialEq, Eq)]
pub struct Server {
    /// `http://host:port`, without a trailing slash.
    pub origin: String,
    pub token: Option<String>,
}

/// The server's address and token, taken out of this process's environment: whatever this program
/// starts inherits its environment, and the token must reach this program alone (a core started
/// from it would hand the token to every agent).
///
/// # Safety
/// Call it before any thread exists: it changes the process's environment.
#[must_use]
pub unsafe fn take_server_vars() -> BTreeMap<String, String> {
    let vars = ["OVIS_URL", "HOST", "PORT", "OVIS_TOKEN"]
        .into_iter()
        .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
        .collect();
    for name in ["OVIS_TOKEN", "OVIS_URL"] {
        // SAFETY: the caller guarantees no other thread reads or writes the environment yet
        unsafe { std::env::remove_var(name) };
    }
    vars
}

/// The token is never printed, whatever prints a `Server`.
impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server")
            .field("origin", &self.origin)
            .field("token", &self.token.as_ref().map(|_| "<hidden>"))
            .finish()
    }
}

impl Server {
    /// From environment-like pairs. `OVIS_URL` (a full origin such as `http://127.0.0.1:7317`, a
    /// trailing slash dropped) wins. Otherwise `HOST` (default 127.0.0.1; a wildcard address means
    /// loopback) and `PORT` (default 7317). `OVIS_TOKEN` when it is non-empty.
    #[must_use]
    pub fn from_env(vars: &BTreeMap<String, String>) -> Server {
        let set = |key: &str| {
            vars.get(key)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
        };
        let origin = match set("OVIS_URL") {
            Some(url) => url.trim_end_matches('/').to_owned(),
            None => {
                let host = match set("HOST").unwrap_or(LOOPBACK) {
                    "0.0.0.0" => LOOPBACK.to_owned(),
                    "::" | "[::]" => "[::1]".to_owned(),
                    host if host.contains(':') && !host.starts_with('[') => format!("[{host}]"),
                    host => host.to_owned(),
                };
                format!("http://{host}:{}", set("PORT").unwrap_or(DEFAULT_PORT))
            }
        };
        let token = vars
            .get("OVIS_TOKEN")
            .filter(|token| !token.is_empty())
            .cloned();
        Server { origin, token }
    }

    /// The `Authorization` header value a call carries, when a token is set.
    pub(crate) fn bearer(&self) -> Option<String> {
        self.token.as_ref().map(|token| format!("Bearer {token}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_never_printed() {
        let server = Server {
            origin: "http://127.0.0.1:7317".into(),
            token: Some("s3cret-token".into()),
        };
        assert!(!format!("{server:?}").contains("s3cret-token"));
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn origin_follows_ovis_url_host_and_port() {
        let cases: &[(&[(&str, &str)], &str)] = &[
            (&[], "http://127.0.0.1:7317"),
            (
                &[("OVIS_URL", "http://10.0.0.2:9000/")],
                "http://10.0.0.2:9000",
            ),
            (
                &[("OVIS_URL", "http://a:1"), ("HOST", "b"), ("PORT", "2")],
                "http://a:1",
            ),
            (
                &[("HOST", "0.0.0.0"), ("PORT", "8000")],
                "http://127.0.0.1:8000",
            ),
            (&[("HOST", "box.local")], "http://box.local:7317"),
            (&[("HOST", "::")], "http://[::1]:7317"),
            (&[("HOST", "fd00::5")], "http://[fd00::5]:7317"),
        ];
        for (pairs, origin) in cases {
            assert_eq!(Server::from_env(&env(pairs)).origin, *origin, "{pairs:?}");
        }
    }

    #[test]
    fn token_only_when_non_empty() {
        assert_eq!(Server::from_env(&env(&[("OVIS_TOKEN", "")])).token, None);
        assert_eq!(
            Server::from_env(&env(&[("OVIS_TOKEN", "s3")]))
                .token
                .as_deref(),
            Some("s3")
        );
    }
}
