### Added
- A PC whose relay pass allows no new device sessions (account limits) now tells the relay of a new
  device that pairs with it, so the relay closes that device `4403` while passes are enforced: no
  device is made, the pairing code is not spent, and no failed pairing is counted. Devices the PC
  already knows sign in as before, and a client that has not paired learns nothing of the limit.
  The relay's `sync` now also says its pass mode (`relay_pass.mode`).
