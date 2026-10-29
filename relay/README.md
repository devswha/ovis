# Ovis relay

The meeting point for a PC running Ovis and a phone or browser that cannot reach it directly, at
`relay.ovis.sh`. Both sides dial out to the relay, which pairs their WebSockets by the PC's
`server_id` and passes frames between them as they came. The frames are end-to-end encrypted
between the device and the PC, so the relay carries ciphertext it has no key for.

One routing core (`core.ts`) runs in two places: a Cloudflare Worker with one Durable Object per
`server_id` (`worker.ts`, deployed as `relay.ovis.sh`), and a plain Bun server (`bun.ts`) for the
tests and for anyone running their own.

## What it answers

`GET /health`: `200 ok`.

`GET /v1/ws?server_id=<32 lowercase hex>&role=...&v=1`, a WebSocket upgrade. `v` is the wire
version; any version other than `1` (or none) is accepted and then closed with `1008`, so an
outdated peer learns why. A malformed `server_id`, `role` or `connection_id` is `400` before any
upgrade, and a request that is not an upgrade is `426`.

| Socket | Query | Who |
|---|---|---|
| control | `role=server` | the PC, one per `server_id` |
| client | `role=client` | a phone or browser; the relay picks its `connection_id` |
| data | `role=server&connection_id=<id>` | the PC, one per client |

- A client's first frame is `{"type":"assigned","connection_id":"<32 hex>"}`, its random 128-bit id.
- The control socket hears `{"type":"sync","connection_ids":[...]}` when it opens (the clients
  still waiting for a data socket), `{"type":"connected","connection_id":"..."}` when a client
  arrives and `{"type":"disconnected","connection_id":"..."}` when one leaves. The PC answers
  `connected` (or `sync`) by opening the client's data socket. Anything else the PC sends on the
  control socket is dropped.
- From then on, every frame from the client goes to its data socket and back, text as text and
  binary as binary, byte for byte. Frames a client sends before its data socket attaches are held
  and handed over in order when it does.
- Keepalive: a socket that sends exactly `{"type":"ping"}` gets `{"type":"pong"}` back, and nothing
  is passed on. The PC sends it on its control socket every 10 s and counts the relay gone after
  30 s without an answer. On Cloudflare the runtime answers it (`setWebSocketAutoResponse`)
  without waking the Durable Object, so an idle PC costs nothing.

## Limits and close codes

| Limit | Value | Past it |
|---|---|---|
| frame size | 64 KiB (Ovis frames stay under about 22 KiB) | that socket closes `1009` |
| clients per `server_id` | 8 | the new client closes `1013` |
| clients waiting for their data socket, per `server_id` | 4 | the new client closes `1013` |
| frames held for a waiting client | 200 frames or 1 MiB, whichever comes first | the client closes `1013` |
| idle | 120 s without a frame or keepalive | the socket closes `1001` |
| connections per address (Cloudflare) | 30 a minute | `429`, `Retry-After: 60` |
| connections from all addresses (Cloudflare) | 600 a minute | `429`, `Retry-After: 60` |

| Code | Meaning |
|---|---|
| `1001` | to a data socket: its client left. To any socket: idle, or a data socket for a client that is gone |
| `1008` | to a control socket: a newer control socket for the same `server_id` replaced it. Also an unknown wire version, or a second data socket for one client |
| `1009` | a frame over 64 KiB |
| `1012` | to a client: its data socket (the PC's side) went away, or the relay lost the frames it held (a Durable Object evicted mid-wait); reconnect |
| `1013` | a limit above; try again later |

The newest control socket wins rather than the first, because an older one may be half-open after
the PC's network moved; the PC reconnects within its backoff either way. The rate limits are
Cloudflare's Rate Limiting bindings (`wrangler.toml`), counted per Cloudflare location and
approximate; the per-address limit is asked first, so one address over its limit never uses up
the backstop every PC shares. On Cloudflare the idle check runs from a Durable Object alarm. A
socket is never closed sooner than 120 s after its last frame or keepalive. After the Durable
Object was evicted, the relay knows only a last-seen time each socket saves at most every 30 s,
and counts from 30 s after it, so such a socket closes at most 150 s after its last frame.

## What it sees and keeps

It sees, per socket: the `server_id`, the role, the `connection_id`, when frames pass and how
large they are, and the connecting address (as the key of the per-address rate limiter only). It
does not see what a frame says: frames are encrypted end to end, and the relay neither parses nor
logs them.

It keeps nothing. Who each socket is lives in memory and, on Cloudflare, in the socket's own
attachment, which is gone with the socket. A client's frames are held in memory only until its
data socket attaches. The Durable Object's SQLite storage stays empty (it holds the idle alarm
only), Workers Logs are off (`[observability] enabled = false`), and nothing writes a log line. A
relay restart or a Cloudflare deploy drops every socket; the PC reconnects and announces itself
again, and clients reconnect.

## Deploy

`relay.ovis.sh` is deployed from CI only, never from a laptop: the Relay deploy workflow
(`.github/workflows/relay-deploy.yml`) runs on a push to main that touches `relay/` once CI passes,
and by hand from main. It runs `bun test ./relay`, then `bunx wrangler deploy` in `relay/` with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then `curl -fsS https://relay.ovis.sh/health`.
A deploy drops every socket; the PC and clients reconnect. Without the two secrets the job passes
with a notice naming the missing one and deploys nothing. It needs the `ovis.sh` zone on the deploying
account: the route in `wrangler.toml` makes `relay.ovis.sh` a custom domain of the Worker, and
`workers_dev = false` leaves no second address. The deploy creates the Durable Object class
(`[[migrations]]`) and the two rate limiters (`[[ratelimits]]`, whose `namespace_id` only has to
be unique among the account's limiters). The Worker itself has no secrets.

One-time setup by the owner:

1. Put the account on the Workers Paid plan (Durable Objects need it) and set a billing alert at
   $20 a month.
2. Add the `ovis.sh` zone to that account; the first deploy attaches `relay.ovis.sh` to it as the
   Worker's custom domain.
3. Create an API token that can edit Workers (Workers Scripts: Edit, plus the zone's Workers
   Routes and DNS for the custom domain) and note the account ID.
4. In GitHub, create the `production` environment (Settings > Environments) with the maintainer as
   a required reviewer, and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets of
   that environment. The reviewer is configured in GitHub, not in the workflow.

A release guard like the Worker one in `scripts/release-guards.ts` is added only when the relay's
wire version changes (`v=1`); there is none in v1. To check the bundle without deploying:

```sh
cd relay
bunx wrangler deploy --dry-run --outdir /tmp/relay-dist
```

## Running your own

Either deploy the Worker to your own Cloudflare account (change `name` and the route in
`wrangler.toml`), or run the Bun server anywhere Bun runs:

```sh
bun relay/bun.ts --port 8787 --hostname 127.0.0.1
```

It listens on plain HTTP, so put it behind a TLS proxy (Caddy, nginx, `tailscale serve`) and give
the PC and devices the `wss://` address. The Bun server applies no rate limit of its own
(`startBunRelay({ limiters })` takes the same limiter shape as Cloudflare's); the per-socket
limits above hold everywhere.

## Tests

`bun test ./relay` from the repository root. `bun.test.ts` runs the Bun relay on a free port and
drives real WebSockets through it: pairing, holding and its limits, close codes, the client caps,
oversized frames, byte-for-byte forwarding and a fake rate limiter. `worker.test.ts` runs the
Worker and the Durable Object over a fake Durable Object state, including an eviction between
frames, the idle alarm and the limiters. In CI they run with the unit tests in Fast checks
(`scripts/ci-tests.ts`), as does the typecheck.

`bun relay/load-smoke.ts --pcs 200 --clients 4` starts the Bun relay, connects 200 PCs with 4
clients each, sends 50 random frames each way per client and prints frames sent and received;
it exits 1 unless every frame arrived intact and in order. `--url ws://host:port` points it at a
running relay instead.
