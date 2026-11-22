### Fixed
- A PC removed from an account with **I didn't add this** no longer keeps opening for that account's
  devices. Before it lets one in, the PC asks the account service whether its own add still stands,
  and it leaves the account when that add is gone or was replaced. One answer is used for at most
  60 seconds, so a removal refuses new sign-ins within a minute.
- When a PC cannot reach the account service to ask, the device says so and keeps its key, instead
  of reading the refusal as its own removal.
- On this PC's own page, adding it to an account that still shows its earlier add as complete works
  again.
- After an hour in which a PC could not confirm its account, the account's devices are signed out of
  it until it can, also those another device of the account approved. Devices paired with the PC
  itself keep working.

- A PC removed from an account is no longer put back by a device that still has it paired: opening
  it adds nothing to the account, and the PC joins an account again only when it is added at the PC
  itself.

- When a PC leaves an account, a phone that was paired with the PC's own QR code and then joined the
  account with the same key keeps its own access to the PC.

### Changed
- **Remove** in Manage account now takes the PC out of the account for good, also a PC that was
  added by pairing a device: once it is online again, the account's devices no longer open it, and
  devices paired with the PC itself still do.
- A PC that was added to an account in one press before this release is added again once after the
  update: the account's devices show **Add this PC to your account again** for it. Devices paired
  with the PC itself keep working.
