### Changed
- `ovis add` (also `login` and `link`) now ends in one QR code: after the sign-in, scan it with a
  device that is signed in to the same Ovis account (or type its code at app.ovis.sh) and the PC
  joins the account, with no Add to press, no digits to compare and nothing to answer in the
  terminal. The code is a key to the PC, so it is drawn only on a terminal (`--print` writes it
  anyway), on a screen of its own that is cleared when a device paired, when the run stops and on
  Ctrl+C, is taken back however the run ends, and comes three codes at most (about 30
  minutes). The command then says which account the PC joined and which of that account's devices
  added it, fails when that is another account than the one that signed in, and asks whether to
  keep any device that got in with the code without being in the account (anything but y removes
  it; a line that comes within a second and a half of the question, and the first line after the
  question changed, answer nothing and it is asked again). `ovis add --approve` keeps the
  earlier way: the adding device's request is approved in the terminal by typing its six digits.
