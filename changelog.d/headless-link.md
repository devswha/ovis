### Added
- A PC with no screen links itself from its terminal: `bun scripts/plugin.ts link` signs in to your
  account with a device code and approves the device that adds the PC after comparing six digits,
  and `link --code` prints a code to type and the relay QR code, renewed until Ctrl+C.
