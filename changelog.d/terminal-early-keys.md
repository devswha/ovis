### Fixed
- Keys typed into a terminal right after it opens, before it takes input, are no longer lost: they
  are sent in order once it does. If it does not within a few seconds, text is held for review as
  before, and a key that cannot be held (Escape, an arrow) says it was not sent.
