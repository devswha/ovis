### Fixed
- `POST /api/pane/input` and `POST /api/pane/keys` no longer type into a pane another web bridge
  holds, while this server has an attachment reporting that hold: like the page, they send nothing
  and answer `409 attach_held` until that bridge lets go. This includes local pane routes in the
  machine profile; that profile refuses connection-management routes separately.
