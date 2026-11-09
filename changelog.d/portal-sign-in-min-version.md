### Fixed
- Portal's sign-in now starts only on Portal v2.7.3 or later. An older Portal let a session cookie
  from the short address pass for another identity that took the same name while Portal was down;
  Start now refuses it and says to update Portal or start without a sign-in.
