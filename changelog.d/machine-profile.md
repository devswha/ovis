### Added
- `OVIS_PROFILE=machine ovis-server serve` serves an existing classic herdr through Ovis's
  ordinary device relay, with loopback HTTP, filtered snapshots and authenticated engine health.
  Engine changes and network publishing are unavailable. Direct connections remain off pending the
  network policy.
  Only this PC itself and a device with a valid proof get in: the pairing gate is closed from the
  first start, and a Tailscale identity header lets nobody in.
- Machine-profile starts share one lease per canonical Ovis state directory, across ports and checkouts.
  The profile refuses a default Ovis state folder and a folder whose Ovis supervisor is running: it
  needs a folder of its own, named with `OVIS_STATE_DIR`.
