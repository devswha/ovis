### Added
- `OVIS_PROFILE=machine` with `OVIS_RUNTIME=herdr-core` serves a herdr-core that is already running,
  selected by `HC_SOCKET` or `HC_SESSION`, through its native socket only: the server never starts,
  stops or updates the core or `hc` (hc's own `hc hold` starts again a core killed while one of its
  terminals is open; stop a core with `hc server stop`). While the core is absent or gone the server keeps answering and
  its authenticated health says why; once the core is started again the same server reconnects by
  itself, and text typed meanwhile is not sent.
