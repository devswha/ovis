//! Reading a file that holds a secret (the machine key, `fleet.json`, `advert.json`, the selftest's
//! configuration). The path is opened with `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` and only then checked,
//! through `fstat` on that same open file: a symbolic link is refused by the open itself, a FIFO or a
//! device cannot block the open, a terminal named there never becomes the agent's controlling
//! terminal, and nothing can swap the file between the check and the read. Only a regular file that no one
//! but its owner may read or write (mode 0600 or stricter) is read.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrivateFileError {
    Unreadable,
    Symlink,
    NotAFile,
    Exposed,
    TooLarge,
}

#[cfg(unix)]
fn open(path: &Path) -> Result<File, PrivateFileError> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY).open(path).map_err(|error| {
        if error.raw_os_error() == Some(libc::ELOOP) {
            PrivateFileError::Symlink
        } else {
            PrivateFileError::Unreadable
        }
    })
}

#[cfg(not(unix))]
fn open(path: &Path) -> Result<File, PrivateFileError> {
    OpenOptions::new().read(true).open(path).map_err(|_| PrivateFileError::Unreadable)
}

/// The file's bytes, at most `max`; wiped when dropped.
pub fn read(path: &Path, max: u64) -> Result<Zeroizing<Vec<u8>>, PrivateFileError> {
    let mut file = open(path)?;
    let metadata = file.metadata().map_err(|_| PrivateFileError::Unreadable)?;
    if !metadata.is_file() {
        return Err(PrivateFileError::NotAFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(PrivateFileError::Exposed);
        }
    }
    let mut bytes = Zeroizing::new(Vec::new());
    (&mut file).take(max + 1).read_to_end(&mut bytes).map_err(|_| PrivateFileError::Unreadable)?;
    if bytes.len() as u64 > max {
        return Err(PrivateFileError::TooLarge);
    }
    Ok(bytes)
}
