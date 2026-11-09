### Added
- On Windows, Ovis chooses and switches its runtime as on Linux and macOS: a PC with the Herdr app
  and no herdr serves the app's terminals (herdr-core) by itself, and **Settings → About → Terminals**
  switches between herdr and herdr-core, restarting Ovis on the choice. The look for herdr there
  reads its Windows places (`herdr.exe` in `%LOCALAPPDATA%\Programs\Herdr\bin`, `%APPDATA%\herdr`).
  `install.ps1` still installs herdr, since the plugin runs under it, and says so. **Move everything
  to herdr-core** stays on Linux and macOS.
