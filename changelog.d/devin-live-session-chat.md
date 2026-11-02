### Fixed
- Fresh Devin CLI sessions on Linux can open as structured chat without a reported session ID
  or a resume argument. Resolve the session from the direct ACP child's exclusive kernel lock
  and recheck ownership after reading, rather than guessing from recent database rows.
