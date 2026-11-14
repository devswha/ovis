//! What the terminal client knows of the local Ovis server: its HTTP and WebSocket contract
//! (`shared/protocol.ts` is the owner of that contract), the inbox's rows, and the inbox as a
//! screen. None of it needs a terminal or herdr-core, so all of it runs under test.

pub mod api;
pub mod inbox;
pub mod live;
pub mod net;
pub mod resume;
pub mod ui;
