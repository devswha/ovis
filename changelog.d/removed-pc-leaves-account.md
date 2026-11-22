### Fixed
- A PC removed from an account with **I didn't add this** no longer keeps opening for that account's
  devices. Before it lets one in, the PC asks the account service whether its own add still stands,
  and it leaves the account when that add is gone or was replaced. One answer is used for at most
  60 seconds, so a removal refuses new sign-ins within a minute.
- When a PC cannot reach the account service to ask, the device says so and keeps its key, instead
  of reading the refusal as its own removal.
- On this PC's own page, adding it to an account that still shows its earlier add as complete works
  again.

### Changed
- A PC that was added to an account in one press before this release is added again once after the
  update: the account's devices show **Add this PC to your account again** for it. Devices paired
  with the PC itself keep working.
