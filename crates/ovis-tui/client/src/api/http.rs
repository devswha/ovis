//! A blocking client for the routes the terminal client calls (shared/protocol.ts HTTP API).

use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;

use super::error::{refusal, status_error};
use super::{ApiError, Conversation, Health, Prompt, SeenFinish, Server, Snapshot};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// A conversation page can be large; ureq's default body cap is 10 MB.
const BODY_LIMIT: u64 = 64 * 1024 * 1024;

/// One answer to a prompt: the option picked, by its index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub pane_id: String,
    pub prompt_id: String,
    pub option_index: usize,
}

/// What became of an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnswerOutcome {
    /// 200 `{ ok: true }`.
    Sent,
    /// 409 `prompt_changed`: the prompt is not the one answered; read it again.
    PromptChanged,
    /// 400: the server's message.
    Refused(String),
}

/// How a finish came to be in front of the user (shared/seen.ts `SeenPresentation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presented {
    /// Its agent was brought into view: someone looked.
    New,
    /// Its agent was already in view when it finished.
    Held,
}

/// The local server's HTTP API, bounded: about 2 s to connect, 5 s per request.
pub struct Client {
    server: Server,
    agent: ureq::Agent,
}

enum Body<'a> {
    Empty,
    Json(&'a serde_json::Value),
}

struct Call<'a> {
    path: &'a str,
    pane_id: Option<&'a str>,
    body: Body<'a>,
}

impl<'a> Call<'a> {
    fn get(path: &'a str) -> Call<'a> {
        Call {
            path,
            pane_id: None,
            body: Body::Empty,
        }
    }
}

#[derive(Deserialize)]
struct SessionBody {
    snapshot: Snapshot,
}

#[derive(Deserialize)]
struct PromptBody {
    prompt: Option<Prompt>,
}

#[derive(Deserialize)]
struct SeenBody {
    finishes: Vec<SeenFinish>,
}

#[derive(Deserialize)]
struct OkBody {
    ok: bool,
}

impl Client {
    #[must_use]
    pub fn new(server: Server) -> Client {
        let config = ureq::Agent::config_builder()
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_global(Some(REQUEST_TIMEOUT))
            .http_status_as_error(false)
            .build();
        Client {
            server,
            agent: ureq::Agent::new_with_config(config),
        }
    }

    /// `GET /api/health`.
    ///
    /// # Errors
    /// Any [`ApiError`].
    pub fn health(&self) -> Result<Health, ApiError> {
        self.json(&Call::get("/api/health"))
    }

    /// `GET /api/session`.
    ///
    /// # Errors
    /// Any [`ApiError`].
    pub fn session(&self) -> Result<Snapshot, ApiError> {
        self.json::<SessionBody>(&Call::get("/api/session"))
            .map(|body| body.snapshot)
    }

    /// `GET /api/pane/prompt?pane_id=...`: the menu on the pane's screen, None when none is.
    ///
    /// # Errors
    /// Any [`ApiError`].
    pub fn prompt(&self, pane_id: &str) -> Result<Option<Prompt>, ApiError> {
        let call = Call {
            pane_id: Some(pane_id),
            ..Call::get("/api/pane/prompt")
        };
        self.json::<PromptBody>(&call).map(|body| body.prompt)
    }

    /// `GET /api/pane/conversation?pane_id=...`.
    ///
    /// # Errors
    /// Any [`ApiError`].
    pub fn conversation(&self, pane_id: &str) -> Result<Conversation, ApiError> {
        self.json(&Call {
            pane_id: Some(pane_id),
            ..Call::get("/api/pane/conversation")
        })
    }

    /// `POST /api/pane/prompt/answer` with `{ pane_id, prompt_id, option_index }`.
    ///
    /// # Errors
    /// [`ApiError`] for anything but 200, 400 and 409 `prompt_changed`.
    pub fn answer(&self, answer: &Answer) -> Result<AnswerOutcome, ApiError> {
        let body = serde_json::json!({
            "pane_id": answer.pane_id,
            "prompt_id": answer.prompt_id,
            "option_index": answer.option_index,
        });
        let call = Call {
            body: Body::Json(&body),
            ..Call::get("/api/pane/prompt/answer")
        };
        let (status, text) = self.send(&call)?;
        match status {
            200..=299 => match decode::<OkBody>(&text)? {
                OkBody { ok: true } => Ok(AnswerOutcome::Sent),
                OkBody { ok: false } => {
                    Err(ApiError::Decode(format!("answer not confirmed: {text}")))
                }
            },
            400 => Ok(AnswerOutcome::Refused(refusal(&text).1)),
            409 if refusal(&text).0 == "prompt_changed" => Ok(AnswerOutcome::PromptChanged),
            _ => Err(status_error(status, &text)),
        }
    }

    /// `GET /api/seen`: every finish a client of this server presented.
    ///
    /// # Errors
    /// Any [`ApiError`].
    pub fn seen(&self) -> Result<Vec<SeenFinish>, ApiError> {
        self.json::<SeenBody>(&Call::get("/api/seen"))
            .map(|body| body.finishes)
    }

    /// `POST /api/seen`: this finish was in front of the user, and how it came there.
    ///
    /// # Errors
    /// Any [`ApiError`].
    pub fn mark_seen(&self, finish: &SeenFinish, presented: Presented) -> Result<(), ApiError> {
        let mut body =
            serde_json::to_value(finish).map_err(|error| ApiError::Decode(error.to_string()))?;
        if let Some(fields) = body.as_object_mut() {
            let word = match presented {
                Presented::New => "new",
                Presented::Held => "held",
            };
            fields.insert("presented".to_owned(), serde_json::Value::from(word));
        }
        let (status, text) = self.send(&Call {
            body: Body::Json(&body),
            ..Call::get("/api/seen")
        })?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(status_error(status, &text))
        }
    }

    fn json<T: DeserializeOwned>(&self, call: &Call<'_>) -> Result<T, ApiError> {
        let (status, text) = self.send(call)?;
        if (200..300).contains(&status) {
            decode(&text)
        } else {
            Err(status_error(status, &text))
        }
    }

    /// The status and body of one call; only a transport failure is an error here.
    fn send(&self, call: &Call<'_>) -> Result<(u16, String), ApiError> {
        let url = format!("{}{}", self.server.origin, call.path);
        let bearer = self.server.bearer();
        let response = match call.body {
            Body::Empty => {
                let mut request = self.agent.get(&url);
                if let Some(pane_id) = call.pane_id {
                    request = request.query("pane_id", pane_id);
                }
                if let Some(bearer) = &bearer {
                    request = request.header("Authorization", bearer);
                }
                request.call()
            }
            Body::Json(json) => {
                let mut request = self
                    .agent
                    .post(&url)
                    .header("Content-Type", "application/json");
                if let Some(bearer) = &bearer {
                    request = request.header("Authorization", bearer);
                }
                request.send(json.to_string())
            }
        };
        let mut response = response.map_err(|error| ApiError::Unreachable(error.to_string()))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(BODY_LIMIT)
            .read_to_string()
            .map_err(|error| ApiError::Decode(error.to_string()))?;
        Ok((status, text))
    }
}

fn decode<T: DeserializeOwned>(text: &str) -> Result<T, ApiError> {
    serde_json::from_str(text).map_err(|error| ApiError::Decode(error.to_string()))
}
