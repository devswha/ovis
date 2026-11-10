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
- `ovis add` (also `login` and `link`) and `pair --approve` ask about a device more carefully.
  A line that is neither the request's digits nor empty (a `y` out of habit, a mistyped digit)
  no longer declines the request for good: it answers nothing, one line says what approves and
  what declines, and the question is asked again; Enter by itself still declines. Full-width
  digits typed with an input method approve as the digits they are. A request whose last three
  digits another request shares (one asked about earlier in the run, or waiting now) asks for
  all six, and only all six approve it; one already asked about with three is asked about again
  with all six when such a request comes to wait beside it.
- `ovis add` and `pair --approve` no longer take what was typed before a question as part of
  its answer: the terminal's input is discarded as a request's question first shows, and the
  first line after an answer that did not reach the PC's server answers nothing. Where the
  input cannot be discarded (Windows), the first line after each question answers nothing
  instead and the question is asked again. Digits typed before a question showed are discarded
  with the rest, so Enter pressed at it then declines: type them once the question shows.
- `pair --approve` asks as `ovis add` does: a second line sent right behind an answer no longer
  answers the next request, a line counts only a second and a half after its question showed,
  and input that is not a terminal (`printf '456\n' | ovis pair --approve`) approves nothing:
  each request is declined as it shows. An answer the PC's server does not take is asked for
  again instead of ending the command with an error.
