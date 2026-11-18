### Changed
- A signed-in device that opens a QR code marked as one whose PC checks new devices with the Ovis
  account now lists the PC in its account if needed and has the account vouch for it before it pairs.
  It asks the account to do so without telling the account's other devices; the account decides, and
  each such add counts toward the account's limit on adds. When the account does not vouch, nothing is
  paired, the code is not used, and the screen says why. A PC listed this way stays in the account's
  list if the pairing then fails. Every other QR code pairs as before.
- Add a connection → Ovis relay also lists the PC in the signed-in account beside its QR code when the
  account does not list it yet; the listing never holds the code up.

### Fixed
- A PC that turns a device's first link away (its code ended, the code is for another account, or the
  account did not vouch for the device) and a machine that makes no pairing code by itself now say so in
  plain words instead of a general failure. A refused link no longer makes the device forget its pairing.
