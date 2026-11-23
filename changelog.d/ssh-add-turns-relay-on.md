### Fixed
- A PC added to your account over SSH (Add PC with "Add it to my account") now turns its Ovis relay
  on and waits for it to come online, as `ovis add` does, so your phone can open it. The dialog says
  "Added" only once its relay is online; otherwise it says the PC is in your account but its relay
  is not online yet, and to run `ovis status` there.
- When the account service refuses Add PC's account add because your sign-in is too old, the dialog
  now offers Sign in again in place, and the add goes on by itself without typing the host again.
- The "Machine offline" message on a phone now names a relay turned off on the PC as a cause, next to
  the PC being off.
