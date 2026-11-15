//! The exit codes of `ovis-link` (docs/fleet-link.md section 5, table `exit-codes`, which a test
//! checks against this list).

pub const OK: u8 = 0;
pub const USAGE: u8 = 2;
pub const HANDSHAKE: u8 = 3;
pub const RECORD: u8 = 4;
pub const SESSION: u8 = 5;
pub const CONFIG: u8 = 6;
pub const RUNNING: u8 = 7;
pub const STATE: u8 = 8;
/// `join`: the invite cannot be read (a file, or a line, that breaks section 4).
pub const JOIN_INVITE: u8 = 11;
/// `join`: the invite's controller key is not the one its id derives, or not a member the owner key signed.
pub const JOIN_CONTROLLER: u8 = 12;
/// `join`: the state folder or its files cannot be made or written (a full disk among them).
pub const JOIN_STORAGE: u8 = 14;
/// `join`: the folder already belongs to another controller.
pub const JOIN_ENROLLED: u8 = 15;

/// `(code, commands)` as the document's table lists them.
pub const TABLE: &[(u8, &str)] = &[
    (OK, "status, rejoin, join, runtime-advert, --version, selftest"),
    (USAGE, "any"),
    (HANDSHAKE, "selftest"),
    (RECORD, "selftest"),
    (SESSION, "selftest machine"),
    (CONFIG, "run"),
    (RUNNING, "run"),
    (STATE, "status, rejoin"),
    (JOIN_INVITE, "join"),
    (JOIN_CONTROLLER, "join"),
    (JOIN_STORAGE, "join"),
    (JOIN_ENROLLED, "join"),
];
