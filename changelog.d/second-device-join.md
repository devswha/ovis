### Fixed
- A device of the account now gets Join at once, not Add with a number to type, for a machine another
  device already put in the account (`ovis add` with a QR code): its card, row and details offer Join as
  soon as the machine has come by the account service. A machine that never came by keeps Add, and its
  sheet now also offers Ask to join for one that shows no number.
