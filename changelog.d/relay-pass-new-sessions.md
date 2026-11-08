### Added
- Relay passes may say whether the relay admits new client sessions to the PC: the account service
  can mark a pass so the relay refuses new client sessions to that PC for the pass's lifetime
  (close code 4429, "relay allowance used") while sessions already up keep running. The PC shows
  it as `new_sessions: false` in the pass part of `GET /api/relay`.
