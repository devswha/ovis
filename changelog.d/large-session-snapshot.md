### Fixed
- A browser connecting to a large herdr session (a snapshot over 1 MiB) gets its terminals again
  instead of closing at once with "Terminal output stopped because this device could not keep
  up": only output still queued for the browser counts as a stall, not the size of one message.
