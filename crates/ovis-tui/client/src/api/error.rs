use serde::Deserialize;

/// Why a call to the server did not give what was asked.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    /// Nothing answers at the origin (connection refused, timeout).
    #[error("the Ovis server does not answer: {0}")]
    Unreachable(String),
    /// 401 or 403: the server's message ("token required", ...).
    #[error("the Ovis server refused access: {0}")]
    Unauthorized(String),
    /// Any other non-2xx, from `{ error: { code, message } }`.
    #[error("the Ovis server answered {status} {code}: {message}")]
    Status {
        status: u16,
        code: String,
        message: String,
    },
    /// A 2xx whose body is not the expected JSON.
    #[error("the Ovis server's answer could not be read: {0}")]
    Decode(String),
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorFields,
}

#[derive(Deserialize)]
struct ErrorFields {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

/// The `{ error: { code, message } }` of a refusal; a body of another shape is its own message.
pub(crate) fn refusal(body: &str) -> (String, String) {
    match serde_json::from_str::<ErrorBody>(body) {
        Ok(parsed) => (parsed.error.code, parsed.error.message),
        Err(_) => (String::new(), body.trim().to_owned()),
    }
}

/// The error a non-2xx answer stands for.
pub(crate) fn status_error(status: u16, body: &str) -> ApiError {
    let (code, message) = refusal(body);
    match status {
        401 | 403 => ApiError::Unauthorized(if message.is_empty() { code } else { message }),
        _ => ApiError::Status {
            status,
            code,
            message,
        },
    }
}
