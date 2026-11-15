### Changed
- The Fleet screen's entry in Settings and the machine profile (`OVIS_PROFILE=machine`) are a preview
  behind `OVIS_PREVIEW=fleet`: without it Settings shows no Fleet entry, and a server asked for the
  machine profile says what to set and exits before it touches its state folder.
