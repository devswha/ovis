### Fixed
- Cloudflare relay connections now close both ends after a frame send fails, so clients can
  reconnect without waiting for a later transport close event or timeout.
