### Fixed
- `ovis add` (and `install.sh --add`) no longer stops after 30 seconds waiting for a relay that a PC
  signed in on the link page cannot bring online. After the sign-in it names the account that signed
  in and waits up to 10 minutes for **Add** on that PC's card in Ovis on your phone or another PC,
  then comes online and says **Added**. Ctrl+C or the 10 minutes take the PC off the account's list
  again. `ovis add --qr` keeps the QR code.
- **Add this PC to your account?** adds the PC with any fresh sign-in of the account, a Google
  sign-in without two-step included, instead of saying to add it with the number. It says when the
  account added as many PCs as it may in a day.
