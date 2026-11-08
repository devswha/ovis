### Added
- The connection server can put right a PC reached over SSH whose Ovis cannot update itself (started
  by hand, or too old to take an update asked for from another PC): `POST /api/machines/install`
  installs Ovis there with its official installer at this app's release, or restarts it through its
  own launcher, then updates and connects it again. It can also give a PC with no Ovis yet one the
  same way. SSH uses keys only, and a refusal says what to do. The PC's card offers it in a later
  release.
