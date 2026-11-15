### Changed
- On herdr-core, an open page no longer makes Ovis read every agent's screen for a question each
  second: only the terminals that page shows are read that often, every other one every third
  second as with no page open. With 30 working agents and one page on one of them, Ovis makes
  about 3,500 requests a minute to herdr-core instead of about 8,200.
