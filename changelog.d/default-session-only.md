### Fixed
- Ovis shows herdr's default session even when a named session starts it first, as an
  assistant's session can after a reboot. A `HERDR_SOCKET` in the plugin config still picks the
  session to show.
