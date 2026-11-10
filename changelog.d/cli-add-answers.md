### Fixed
- `ovis add` (also `login` and `link`) no longer takes a line typed ahead as the answer to a device
  that asks to join: only a line typed after a request's question and its six digits showed answers
  it. A line typed during the sign-in, while nothing was asked, twice at one question, or for a
  request that went away is dropped with a line saying so, and piped input declines every request.
- `ovis add` opens its last approval window and lists the PC anew in time when the PC's server
  answers slowly near the end of the run, and puts the PC back in the account's list while the
  account's other devices are still being brought in.
