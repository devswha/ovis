### Fixed
- A PC that this device finds off no longer reads Ready with Open for up to fifteen minutes. Its row,
  its details and Needs you say "Machine offline", when it was last seen and why, and offer Details.
- When this device cannot reach the relay, a PC reads "Could not reach this machine" and says to
  check this device's network; its row offers Check again instead of Open. The screen after Open
  uses the same two headings.
- The list of PCs checks its PCs again every minute while it is open. A check the relay turned away
  no longer reads "No answer": the row keeps what it said, and that PC is checked first next time.
- In the PCs table, a long state wraps to a second line instead of being cut off.
