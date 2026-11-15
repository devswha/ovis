### Fixed
- On herdr-core, a card that waits no longer sends its waiting alert a second time after the core
  restarts (`hc server restart`): a core that stops knowing for a moment which program is in front
  of a terminal is no longer taken for the agent leaving it.
