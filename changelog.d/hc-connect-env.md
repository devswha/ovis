### Fixed
- On herdr-core, a core that Ovis happens to start no longer hands Ovis's own environment (`PORT`,
  `HOST`, `OVIS_*`, `HERDR_WEB_*`, `HERDR_PLUGIN_*`) to every pane, so a dev server in a pane no
  longer takes Ovis's port.
