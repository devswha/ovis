### Fixed
- Owner health omits the SSH fleet counts when the server has no machine manager,
  instead of failing that request.
- A first look at an enabled herdr profile records connection consent only after
  the session read succeeds.
