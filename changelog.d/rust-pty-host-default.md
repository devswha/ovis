### Changed
- Terminals on Linux and macOS run on the Rust PTY host by default, so Node is no longer needed:
  the server checks the release's host once at startup and uses it, and a PC without Node attaches
  its panes on it alone. The Node sidecar remains the fallback for one release, when the host is
  missing or fails its check and the PC has Node 18 or newer; `OVIS_PTY_SIDECAR=node` asks for it.
  The installer and the plugin's build no longer require Node, and `install.sh` installs Node 22
  only when the host cannot be installed and there is no Node.
