### Fixed
- Adding a PC whose own Ovis listens on another address than 127.0.0.1 (its HOST set to, say, its
  Tailscale address) connects through that address instead of failing with "ECONNRESET". When SSH
  cannot reach the PC's Ovis, the error says at which address it was tried and to set
  HOST=127.0.0.1 there.
