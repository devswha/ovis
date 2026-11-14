//! The local Ovis server's HTTP API: where it is, its wire types, and a blocking client.

mod error;
mod http;
mod pane;
mod server;
mod session;

pub use error::ApiError;
pub use http::{Answer, AnswerOutcome, Client, Presented};
pub use pane::{Conversation, Part, Prompt, PromptOption, Role, SeenFinish, Turn};
pub use server::Server;
pub use session::{AgentInfo, Health, Pane, Snapshot, Tab, Workspace, Worktree};

/// The `pc` of this PC's own panes in `/api/seen` records (`LOCAL_MACHINE`, shared/machines.ts:7).
pub const LOCAL_PC: &str = "local";
