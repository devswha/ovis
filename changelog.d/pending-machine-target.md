### Fixed
- A PC whose SSH address is changed in its dialog now moves there only once that setup connects. A
  setup cancelled at its approval, or one that fails, leaves the PC at its own address, so a later
  reconnect or bridge update no longer starts this app's bridge at an address that was never approved.
- A PC's own Ovis that updated itself but still answers an older version than this app's keeps its
  address and link on the PC's card, with why it cannot be updated from here.
