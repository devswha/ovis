### Changed
- Signing in on a PC (Settings → Devices and PCs → Account, the first-run welcome, the desktop app)
  now adds that PC to the account in the same step: it lists itself and waits for one of your
  devices to add it, with no second "Add this PC to my account" press. A sign-in that was already
  there keeps the button. With the relay off, one button, "Turn on the relay and add this PC",
  does both; the relay is never turned on without a press. A browser that is in only because
  the device gate is still open is paired first, so turning the relay on does not shut it out.
- Stop waiting on the add-this-PC screen now closes the PC's pairing window at once instead of
  letting it run out.
