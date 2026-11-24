### Added
- A PC that a person added to its account's signed list can let a new device into the list itself:
  the Allow in the PC's own window, and the digits typed at `ovis approve`, sign the device's entry
  with the PC's own key. The account service places it only while a sign-in of the account has
  claimed that device's key, so the PC alone lets in nobody. A PC that follows no list, and a join
  that brings no card, work as before.
- A device a member allowed on a PC that follows no list is told its place in the account's signed
  list through that PC's introduction.
