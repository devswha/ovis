//! The inbox as a screen: its state, what a key or an answer of the server changes in it, and how
//! it is drawn. Nothing here touches a terminal or a socket, so all of it runs under test.
mod card;
mod colors;
mod draw;
mod help;
mod hints;
mod keys;
mod list;
mod look;
mod replies;
mod said;
mod settle;
mod state;
pub mod text;
mod types;

pub use colors::Colors;
pub use draw::{Hits, Scene, draw, rows_of};
pub use look::{Front, Looker, REST};
pub use settle::settle;
pub use state::{Card, Effect, Event, Intent, Link, Loaded, Page, Setup, State, Target};
