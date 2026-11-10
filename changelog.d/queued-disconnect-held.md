### Fixed
- A queued follow-up held when the connection drops or reloads before anything is typed now
  recovers as **Held message — review and send** with **Send now** enabled once the browser
  reconnects, instead of staying stuck as "Not confirmed. Check the terminal before sending
  again."
  ([#3173](https://github.com/devswha/ovis/pull/3173) by @jimbb)

### Changed
- A message the PC held for a reason of its own (a lost connection, a turn that never started, a
  send it refused) keeps **Send now** only while the PC can still confirm that nothing was typed:
  on its own live connection, or for ten minutes after a reconnect of the same browser. After a
  reload, in another tab, after the server restarts or updates, past those ten minutes and on a
  remote PC, it now shows "Not confirmed. Check the terminal before sending again." with Copy and
  Discard, where it used to keep Send now. A message you held yourself (Alt+Enter, or any
  follow-up with automatic sending off) is not affected: it stays held until its Send now.
  ([#3173](https://github.com/devswha/ovis/pull/3173))
