### Added
- `GET /api/fleet/machines` lists a fleet's machines with their state, a fixed `cause` code that says
  why one is not usable (removed, on hold, waiting for confirmation, no place for it on the controller,
  its runtime or server down, and more) and since when, with one plain sentence per cause in every
  language the app has. A skewed clock on a machine is shown as a warning and never stops it.
