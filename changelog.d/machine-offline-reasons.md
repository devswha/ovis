### Fixed
- A PC that this device's own check finds missing from the relay no longer reads Ready with Open
  for up to fifteen minutes because the account heard from it lately. Its row, its details and the
  Needs you list say "Machine offline", when the account last heard from it, and why (it is off,
  has no network, or Ovis is not running on it), and the row offers Details instead of an Open
  that can only fail.
- When this device reaches no relay, a PC reads "Could not reach this machine", says to check this
  device's network, and its row offers Check again in place of Open. The screen after Open uses
  the same two headings for the same two causes: "Machine offline" when the relay had nobody for
  the PC, "Could not reach this machine" when this device reached no relay or the PC did not
  finish connecting in time.
