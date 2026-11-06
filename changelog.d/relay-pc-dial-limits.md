### Fixed
- A PC added through the relay can no longer make this PC's server connect to link-local addresses or
  to other services' ports on its network: only another PC's direct listener is dialed, and a
  connection that keeps dropping no longer checks the direct route again each time it comes back.
