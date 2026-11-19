### Fixed
- The list of PCs no longer says "No answer" for a PC whose check the relay turned away (busy, or a
  dropped connection): the row keeps what it said, and that PC is checked again first a minute later.
  The list now checks its PCs again every minute while it is open, so rows past the first eight and
  rows that did not answer turn current without pressing Check now.
