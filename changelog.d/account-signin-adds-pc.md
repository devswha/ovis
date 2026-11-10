### Changed
- Signing in on a PC (Settings → Devices and PCs → Account, the first-run welcome, the desktop app)
  now adds that PC to the account in the same step: it lists itself and waits for one of your
  devices to add it, with no second "Add this PC to my account" press. A sign-in that was already
  there keeps the button. With the relay off, one button, "Turn on the relay and add this PC",
  does both; the relay is never turned on without a press. The PC is listed only under the
  account that just signed in, and a listing that gets no answer within a minute gives the
  button back.
- Stop waiting on the add-this-PC screen now closes the PC's pairing window at once instead of
  letting it run out.
