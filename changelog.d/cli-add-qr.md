### Changed
- `ovis add` (also `login` and `link`) now ends in one QR code: after the sign-in, scan it with a
  device that is signed in to the same Ovis account (or type its code at app.ovis.sh) and the PC
  joins the account, with no Add to press, no digits to compare and nothing to answer in the
  terminal. The code is a key to the PC, so it is drawn only on a terminal (`--print` writes it
  anyway), on a screen of its own that is cleared when a device paired, when the run stops and on
  Ctrl+C, is taken back however the run ends, and is renewed three times at most (about 30
  minutes). The command then says which account the PC joined and which device added it, fails
  when that is another account than the one that signed in, and asks whether to keep a device
  that paired without being signed in (anything but y removes it). `ovis add --approve` keeps the
  earlier way: the adding device's request is approved in the terminal after comparing six digits.
