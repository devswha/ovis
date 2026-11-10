### Changed
- The desktop app now tells you when an update is ready instead of waiting for you to open the
  tray menu: one system notification per version ("Ovis X.Y.Z is ready"), whose click opens the
  window, and a line in the window with the same Restart to Update as the tray. The line can be
  closed for that version, and the connection screen shows it too, so an app whose server cannot
  start still offers its update.
- The desktop app checks for an update every hour instead of every 6 hours, and no longer
  downloads again a version it already holds.

### Fixed
- The desktop app no longer offers Restart to Update for a downloaded update whose file is gone
  (a newer download that failed removed it): choosing it stopped the Ovis server and installed
  nothing. The update is downloaded again at the next check.
