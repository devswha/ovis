### Changed
- A signed-in device that opens a QR code marked as one whose PC checks new devices with the Ovis
  account, for a PC its account already lists, now has the account check it before it pairs. It asks
  the account to do so without telling the account's other devices; the account decides, and each such
  add counts toward the account's limit on adds. When the account does not confirm it, nothing is
  paired, the code is not used, and the screen says what to do. For a PC the account does not list,
  and for every other QR code, pairing works as before.
- Add a connection → Ovis relay also lists the PC in the signed-in account beside its QR code when that
  is the account named for the PC and it does not list the PC yet; the listing never holds the code up.

### Fixed
- When a PC turns away the first link of a device that paired from such a marked code (its code ended,
  it is set up for another account, or the account did not confirm the device), the device says so in
  plain words and forgets that pairing. A machine that makes no pairing code by itself says so too.
