### Fixed
- In the Android app, a PC's QR code scanned while the app shows your account's PCs now opens that
  PC, instead of leaving the list of PCs on screen.
- A PC's own page, on a signed-in device that the PC still has to approve, now asks to join that PC
  right there: it shows this device's number and says to approve it on the PC's Ovis page or with
  `ovis add --approve`, then opens the PC once it is approved. A refusal or a request that ran out
  is said on the same screen. It no longer falls back to the list of PCs.
