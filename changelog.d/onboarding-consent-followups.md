### Fixed
- Stop waiting on Add this PC now also closes a pairing window that a listing given up for getting
  no answer opens late, a listing stopped on its way opens no window and reads nothing more, and a
  wait begun right after it asks for its window only once that close was answered, so a late close
  no longer shuts the new wait's window.
- A wait to add a PC that is taken up again (after a reload, or every time it reopens its window)
  first reads which PC answers, from a request that opens nothing: an address that now answers for
  another PC no longer gets a pairing window opened on it, and is no longer said to be the PC
  that was added.
- The PC's approval prompt is entered on the prompt itself by Shift+Tab too, not on its buttons, and
  a key cannot press Approve for a second after the focus came into the prompt. Its guards now count
  to when a key or a click was made, so one already on its way when the prompt arrived or moved
  approves nothing on a busy page.
- A pairing confirmed for one sign-in no longer adds the PC to another account when the hosted app
  reloads itself for a newer build before the PC opens and another sign-in is stored by then: the
  PC then opens with the key this device holds and joins no account.
- `install.sh --add` discards what was typed in the terminal while the installer worked before its
  add step starts, so a line typed ahead no longer answers a device's approval there; where it
  cannot be discarded, the installer prints the command to run instead.
