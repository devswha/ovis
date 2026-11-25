### Fixed
- A PC that came into its account's signed list as the account moved, with no key of its own in it
  yet, no longer says it joined by an invite when it is asked to approve a device: `ovis approve`,
  the asking device and an add over SSH say what it is and that `ovis add` on that PC gives it its
  keys. `ovis add` there now does that, by the number compared with a device of the account,
  instead of saying the PC is in an account already.
- A device that a PC keeps out by a block on that PC is no longer told that it was not added to
  the account: `ovis approve` and the device say that the PC keeps every device newer than the
  blocked one out until the block is lifted, and where to lift it.
