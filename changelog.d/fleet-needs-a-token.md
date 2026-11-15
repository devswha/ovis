### Changed
- The fleet needs `OVIS_TOKEN` on every PC that opens fleet machines. Without it, turning the fleet on, minting
  invites, confirming and removing machines are refused with `fleet_token_required`, no machine signs in or enrols
  (each keeps trying and signs in again once the token is set), and `ovis fleet` exits 8. A PC that never turned the
  fleet on works as before.
