### Fixed
- Stop waiting on Add this PC now also closes a pairing window that a listing given up for getting
  no answer opens late, and a wait begun right after it asks for its window only once that close
  was answered, so a late close no longer shuts the new wait's window.
- A wait to add a PC that is taken up again (after a reload, or every time it reopens its window)
  first reads which PC answers, from a request that opens nothing: an address that now answers for
  another PC no longer gets a pairing window opened on it, and is no longer said to be the PC
  that was added.
