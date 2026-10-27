### Fixed
- The installer no longer links the Node it installs into `~/.local/bin`, where it went before the
  Node of your own projects; running it again removes a link it made earlier. Terminals that run on
  the Node fallback use that Node even when herdr's PATH starts with an older one (reported by @wafe).
