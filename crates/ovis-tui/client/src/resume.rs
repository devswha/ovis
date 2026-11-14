//! Where the user was, kept across runs: an SSH connection that drops takes the client with it,
//! and the next run opens on the same place. Nothing typed is ever kept here.
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Spot {
    Inbox,
    Card,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    /// The core's socket: a place in one core means nothing in another.
    pub core: String,
    pub spot: Spot,
    pub pane: Option<String>,
}

/// `$XDG_STATE_HOME/ovis/tui.json`, else `~/.local/state/ovis/tui.json`.
pub fn path(var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let state = var("XDG_STATE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            var("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".local").join("state"))
        })?;
    Some(state.join("ovis").join("tui.json"))
}

/// The place kept for `core`; none when the file is missing, unreadable or of another core.
#[must_use]
pub fn load(file: &Path, core: &str) -> Option<Place> {
    let text = std::fs::read_to_string(file).ok()?;
    let place: Place = serde_json::from_str(&text).ok()?;
    (place.core == core).then_some(place)
}

/// Written beside the file and moved over it, so a cut-off write leaves the old place.
///
/// # Errors
/// The folder cannot be made, or the file not written or moved.
pub fn save(file: &Path, place: &Place) -> std::io::Result<()> {
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let draft = file.with_extension("json.new");
    std::fs::write(&draft, serde_json::to_vec(place)?)?;
    std::fs::rename(&draft, file)
}

/// How long a place waits for a newer one before it is written.
pub const SETTLED: Duration = Duration::from_millis(400);

/// Holds the user's place until it is due for the file: keys held down move it many times a
/// second, and that is one write.
#[derive(Debug)]
pub struct Keeper {
    core: String,
    kept: Option<Place>,
    wanted: Option<Place>,
    due: Option<Instant>,
}

impl Keeper {
    /// `kept` is what the file holds now.
    #[must_use]
    pub fn new(core: String, kept: Option<Place>) -> Keeper {
        Keeper {
            core,
            kept,
            wanted: None,
            due: None,
        }
    }

    /// The user is here now.
    pub fn note(&mut self, spot: Spot, pane: Option<String>, now: Instant) {
        let place = Place {
            core: self.core.clone(),
            spot,
            pane,
        };
        if self.kept.as_ref() == Some(&place) {
            self.wanted = None;
            self.due = None;
        } else {
            self.wanted = Some(place);
            self.due.get_or_insert(now + SETTLED);
        }
    }

    #[must_use]
    pub fn due(&self) -> Option<Instant> {
        self.due
    }

    /// The place to write now; `at` none means whatever waits, due or not (the screen is left).
    pub fn take(&mut self, at: Option<Instant>) -> Option<Place> {
        if let (Some(now), Some(due)) = (at, self.due)
            && due > now
        {
            return None;
        }
        self.due = None;
        let place = self.wanted.take()?;
        self.kept = Some(place.clone());
        Some(place)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(spot: Spot, pane: &str) -> Place {
        Place {
            core: "/run/hc.sock".into(),
            spot,
            pane: Some(pane.into()),
        }
    }

    fn keeper() -> Keeper {
        Keeper::new("/run/hc.sock".into(), None)
    }

    #[test]
    fn a_place_is_written_once_it_has_waited_and_many_moves_are_one_write() {
        let start = Instant::now();
        let mut keeper = keeper();
        keeper.note(Spot::Inbox, Some("t1".into()), start);
        keeper.note(Spot::Inbox, Some("t2".into()), start + SETTLED / 4);
        keeper.note(Spot::Card, Some("t3".into()), start + SETTLED / 2);
        assert_eq!(keeper.due(), Some(start + SETTLED));
        assert_eq!(keeper.take(Some(start + SETTLED / 2)), None);
        assert_eq!(
            keeper.take(Some(start + SETTLED)),
            Some(place(Spot::Card, "t3"))
        );
        assert_eq!(keeper.due(), None);
        assert_eq!(keeper.take(None), None);
    }

    #[test]
    fn leaving_the_screen_writes_what_waits_at_once() {
        let start = Instant::now();
        let mut keeper = keeper();
        keeper.note(Spot::Terminal, Some("t1".into()), start);
        assert_eq!(keeper.take(None), Some(place(Spot::Terminal, "t1")));
    }

    #[test]
    fn the_place_the_file_already_holds_is_not_written_again() {
        let start = Instant::now();
        let mut keeper = Keeper::new("/run/hc.sock".into(), Some(place(Spot::Inbox, "t1")));
        keeper.note(Spot::Inbox, Some("t1".into()), start);
        assert_eq!(keeper.due(), None);
        keeper.note(Spot::Inbox, Some("t2".into()), start);
        keeper.note(Spot::Inbox, Some("t1".into()), start);
        assert_eq!(keeper.take(None), None);
    }

    #[test]
    fn a_place_survives_the_file_and_a_place_of_another_core_is_not_taken() {
        let folder = std::env::temp_dir().join(format!("ovis-tui-resume-{}", std::process::id()));
        let file = folder.join("state").join("tui.json");
        let kept = place(Spot::Terminal, "t7");
        save(&file, &kept).expect("saved");
        assert_eq!(load(&file, "/run/hc.sock"), Some(kept));
        assert_eq!(load(&file, "/run/other.sock"), None);
        std::fs::write(&file, "{ not json").expect("written");
        assert_eq!(load(&file, "/run/hc.sock"), None);
        std::fs::remove_dir_all(&folder).expect("removed");
    }

    #[test]
    fn the_file_is_under_the_state_folder_xdg_names_else_the_home() {
        let xdg = |name: &str| (name == "XDG_STATE_HOME").then(|| OsString::from("/x/state"));
        assert_eq!(path(xdg), Some(PathBuf::from("/x/state/ovis/tui.json")));
        let home = |name: &str| (name == "HOME").then(|| OsString::from("/home/alice"));
        assert_eq!(
            path(home),
            Some(PathBuf::from("/home/alice/.local/state/ovis/tui.json"))
        );
        assert_eq!(path(|_| None), None);
    }
}
