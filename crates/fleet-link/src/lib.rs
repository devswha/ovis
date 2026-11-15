#![forbid(unsafe_code)]

pub mod advert_file;
pub mod agent;
#[doc(hidden)]
pub mod b64;
pub mod carrier;
pub mod channel;
#[cfg(unix)]
pub mod daemon;
#[cfg(unix)]
pub mod dial;
mod error;
pub mod exit;
pub mod fleet;
#[doc(hidden)]
pub mod hex;
pub mod invite;
pub mod invite_file;
#[cfg(unix)]
pub mod join;
pub mod json;
pub mod machine_key;
pub mod mux;
mod noise;
pub mod pace;
pub mod private_file;
pub mod records;
#[cfg(unix)]
pub mod runtime_advert;
pub mod session;
pub mod status;
pub mod supervisor;
pub mod target;

pub use error::Error;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod supervisor_tests;
#[cfg(test)]
mod files_tests;
#[cfg(test)]
mod enroll_tests;
#[cfg(test)]
mod join_tests;
#[cfg(test)]
mod pace_tests;
