### Added
- A relay you run yourself takes `--max-clients-per-server` (`RELAY_MAX_CLIENTS_PER_SERVER`, 8 by
  default) so a PC can have a fleet of machines connected beside its 8 clients, and a v3 relay pass
  can carry a fleet number that sizes a PC's room on Ovis's relays. `bun scripts/build-relay.ts
  <platform> <dir>` builds that relay as one binary, `ovis-relay`, and the Cloudflare Worker as
  one file with a `wrangler.toml` for your own account.
