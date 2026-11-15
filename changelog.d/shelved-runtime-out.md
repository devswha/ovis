### Removed
- The runtime name `alt-runtime`, a placeholder that no release could start.
  `OVIS_RUNTIME=alt-runtime` now stops the start as a runtime Ovis does not know (before, as one it
  cannot start yet). A remote PC's bridge (`ovis-server remote`) started with it still runs, but
  answers `GET /api/health?scope=bridge` with 500 `internal_error` (before, 200 naming
  `alt-runtime`); its `/api/health` answers as before (200 when herdr answers). `POST /api/runtime` with `alt-runtime`
  answers 400 `invalid_runtime` where the server looks at the name (before, 409 there:
  `runtime_locked` while the choice is locked, `runtime_switching` while the server starts or
  switches, `runtime_unavailable` otherwise). The route's own 409s, which come before the name is
  looked at, stay as they were: `runtime_locked` from a server with no runtime switch,
  `runtime_switching` while a move to herdr-core waits or runs. The message of `invalid_runtime` for
  any other unknown name no longer lists it, and the wire values `alt-runtime` (a runtime name in
  the runtime facts of `/api/health`) and `no_alt_runtime` (their fallback) are gone. A
  `runtime-<port>.json` written by hand that names it is read as no choice, so the server picks the
  runtime from what the PC has (before, where the saved choice decides, it served herdr and Settings
  said why).

### Changed
- `POST /api/workspace/create` answers 409 `unsupported_runtime` to a body that carries `program` or
  `first_message_wait_ms`, also when the field is `null`, when the request gets that far (past the
  sign-in, origin and body checks; before, both fields were ignored); no engine starts a program
  that way yet.
