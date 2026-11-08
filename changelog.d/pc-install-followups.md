### Fixed
- Cancelling an update of another PC asks that PC's own Ovis to stop it, while it still checks or builds,
  and says it stopped only once that PC confirms it; otherwise (an older Ovis, or one already restarting)
  it says the update may still finish there, never that it ended.
- An install over SSH that finds an older Ovis there updates it only to the release shown (this app's).
- One install or setup per PC holds even when ssh cannot resolve an address, and resolving addresses no
  longer holds the server up.
