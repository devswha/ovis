### Changed
- Under the fleet preview, with `OVIS_PROFILE=machine` (both in the environment or in the plugin's
  settings file, as the server it starts reads them), the plugin reaches a machine profile through
  its owner socket, `serve.sock` in its state folder, which the profile records there
  (`serve.lock/http.json`), as `http://localhost` and with no token, instead of its TCP port, which
  answers liveness only. Its health check (as `status`, `start`, `phone`, `phone-setup`, `pair` and
  `add` make it) and the requests of `add` (also `link` and `login`), `pair` (also `--approve`) and
  `phone-setup` go there, and a command keeps the door its health check passed on for all its
  requests. The plugin takes the socket only when the state folder passes the profile's own check
  and `serve.sock` is a socket this account owns, and reads the record only as a regular file of
  at most 4 KiB. A profile whose herdr does not answer counts as running, and `status` adds
  `engine: down` with the profile's reason. Without the preview, without `OVIS_PROFILE=machine`,
  or without a readable record there that names that socket (`door: 1`), the plugin uses the TCP
  port as before.
