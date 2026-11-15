# Fleet link

The wire contract between a fleet controller (an Ovis server) and a fleet machine (a host running
the Rust link agent `ovis-link`). The machine dials home, proves who it is with
a machine key, and then answers the byte pipes the controller opens to its loopback bridge server
and to its runtime socket. This document was written before any of its code. The codecs, the
session and the agent are built by todos 20, 21, 22, 23, 30, 31, 37 and 59 of the relay-fleet plan,
each against the vectors in [`server/fleet/vectors/`](../server/fleet/vectors).

Where this contract lives: the fleet link's wire contract (the `machine-key` scheme, the pipe,
ENROLL, PACE and FLEET_STATE frames, the invite format and the vectors) lives only in private files:
`server/fleet/`, `crates/fleet-link` and this document. `shared/` and `src/` carry only what the
app shows of a fleet (the machine kind `fleet` of todo 26, the cause list of todo 34 and the Fleet
screen of todo 33), with no frame type, scheme name or key format. The shared mux
(`shared/relay-mux.ts`, `shared/relay-mux-engine.ts`) gains only a neutral extension hook (todo 20).

Everything below extends Ovis Mux v1 as [relay.md](relay.md) describes it and
`shared/relay-mux.ts` implements it. What is not said here is as it is there.

## Conventions

- **Bytes on the wire.** Every frame is the 8-byte mux envelope (byte 0 the relay protocol `1`,
  byte 1 the type, bytes 2-3 the flags, bytes 4-7 the stream id, both big-endian) and its payload.
  Metadata payloads are UTF-8 JSON objects; duplicate keys are refused and unknown keys ignored, as
  today.
- **Canonical encoding.** An encoder writes compact JSON (no whitespace) with the keys in the order
  of the field table below, as `JSON.stringify` writes an object built in that order. Every accepted
  vector whose case is not marked `"canonical": false` is in this form, so an encoder in any
  language must reproduce its bytes exactly; a decoder takes any key order and whitespace.
- **Encodings named in the tables.** `hex` is lowercase hexadecimal. `base64url` is RFC 4648 section
  5 without padding, canonical (the unused bits of the last character are zero), as
  `shared/relay-mux.ts` reads it. `base64` is standard base64 with padding. Integers are JSON numbers
  without fraction or exponent, always within 0 .. 2^53 - 1.
- **Signed and hashed byte strings** are concatenations (`||`) of fixed-length parts: ASCII domain
  labels, ids as the ASCII bytes of their lowercase hex text (as the device AUTH signs `server_id`,
  `shared/relay-device.ts:74-84`), and keys, nonces and bindings as raw bytes. Every part has a fixed
  length, so no concatenation can be read two ways.
- **Decided in todo 9** marks a value the plan left open, with its reason. They are all listed in
  "Decisions made in todo 9" at the end.

## Frame types

The types in use today, read from `FrameType` in `shared/relay-mux.ts:41-50`: `0x01`-`0x0e`
(HELLO .. PAIR_CONFIRM), `0x10`-`0x15` (HTTP), `0x20`-`0x23` (WS), `0x30`-`0x31` (CREDIT, RESET).
The fleet link takes `0x40`-`0x48` from the extension range `0x40`-`0x4f` that todo 20 opens to a
registered extension. None collides with a type in use, `0x49`-`0x4f` stay free for later fleet
frames, and `0x0f`, `0x16`-`0x1f`, `0x24`-`0x2f` and `0x32`-`0x3f` stay with the public mux.
`scripts/fleet-contract-check.ts` checks the first two statements against the code on every run.

Without the extension registered, a type `0x40`-`0x4f` stays a protocol error, as today
(`envelope` in `shared/relay-mux.ts` refuses any type not in `FrameType`). With it registered
(`server/fleet/mux-ext.ts`, through the `MuxExtension` hook of `shared/relay-mux.ts`), a type of that range
that the extension does not read is a protocol error too: `0x49`-`0x4f` always, and `0x47` until todo 37 adds its
reader (todo 21 added the pipe frames `0x40`-`0x44`, todo 30 ENROLL and ENROLL_OK `0x45`-`0x46` and todo 31
FLEET_STATE `0x48`, read only on a session that selected `pipe-stream`). The pipe frames
`0x40`-`0x43` are stream frames; `0x44`-`0x48` are session frames and need stream id 0 (decided in
todo 9: the session frames carry state of the whole machine session, the stream frames belong to
one pipe). Flags are 0 on every frame of this contract; any other value is `protocol_error`.

<!-- contract:frames -->
| Type | Frame | New | Stream id | Sent by | Max bytes | Vectors |
| --- | --- | --- | --- | --- | --- | --- |
| `0x01` | `HELLO` | no | 0 | machine | 4096 | auth.json |
| `0x02` | `WELCOME` | no | 0 | controller | 4096 | auth.json |
| `0x03` | `AUTH` | no | 0 | machine | 1024 | auth.json |
| `0x04` | `AUTH_OK` | no | 0 | controller | 1024 | auth.json |
| `0x05` | `SESSION_ERROR` | no | 0 | either | 1024 | auth.json |
| `0x06` | `GOAWAY` | no | 0 | either | 1024 | pipe-frames.json |
| `0x07` | `PING` | no | 0 | either | 16 | pipe-frames.json |
| `0x08` | `PONG` | no | 0 | either | 16 | pipe-frames.json |
| `0x09` | `RECEIVED` | no | 0 | either | 16 | pipe-frames.json |
| `0x30` | `CREDIT` | no | pipe id | either | 16 | pipe-frames.json |
| `0x31` | `RESET` | no | pipe id | either | 1024 | pipe-frames.json |
| `0x40` | `PIPE_OPEN` | yes | even, from 2 | controller | 1024 | pipe-frames.json |
| `0x41` | `PIPE_ACCEPT` | yes | pipe id | machine | 8 | pipe-frames.json |
| `0x42` | `PIPE_DATA` | yes | pipe id | either | 16384 | pipe-frames.json |
| `0x43` | `PIPE_END` | yes | pipe id | either | 8 | pipe-frames.json |
| `0x44` | `PIPE_ADVERT` | yes | 0 | machine | 4096 | pipe-frames.json |
| `0x45` | `ENROLL` | yes | 0 | machine | 1024 | enroll.json |
| `0x46` | `ENROLL_OK` | yes | 0 | controller | 1024 | enroll.json |
| `0x47` | `PACE` | yes | 0 | controller | 1024 | pace.json |
| `0x48` | `FLEET_STATE` | yes | 0 | controller | 1024 | auth.json |
| `file` | `INVITE` | file | none | controller | 4096 | invite.json |
| `file` | `INVITE_LINE` | file | none | controller | 5476 | invite.json |
| `file` | `FLEET_FILE` | file | none | installer | 16384 | machine-files.json |
| `file` | `ADVERT_FILE` | file | none | bridge | 16384 | machine-files.json |

The existing frames are listed because a machine session changes what they carry: HELLO offers
`pipe-stream`, WELCOME names `max_pipe_streams`, AUTH has the scheme `machine-key`, AUTH_OK answers
a machine, and GOAWAY, CREDIT and RESET carry even stream ids. SESSION_ERROR, PING, PONG and
RECEIVED carry what they carry today; they are listed so that the link agent's encoder and reader
(todo 23) are checked against vectors for every frame a machine sends or reads. Without `pipe-stream` selected,
CREDIT, RESET and GOAWAY keep today's rule that a stream id is odd (`streamId` in
`shared/relay-mux.ts:369-373`), and a pipe frame is refused.

## 1. The machine session

1. **Carrier and channel.** The machine dials the controller: a direct carrier first, else the
   relay (todos 24, 29, 37). On either it runs `Noise_NK_25519_ChaChaPoly_SHA256` with prologue
   `paseo-relay-e2ee/1` against the controller's static key pinned in its invite
   (`controller.server_public_key`, section 4), in protected mode only (the legacy mode is off,
   `shared/relay-e2ee.ts:16-17`). Both ends then hold the **channel binding**: SHA-256 over
   `"ovis-relay-channel-binding/1" || controller static public key (32 bytes) || u32be(len) || Noise
   message 1 || u32be(len) || Noise message 2` (`channelBinding`, `shared/relay-e2ee.ts:72-85`).
   auth.json's `derivations.channel_binding` fixes one example of this formula.
2. **WELCOME** (controller, may go before HELLO as today) names the limit `max_pipe_streams: 16`
   after the v1 limits. A peer that does not know it ignores it (`limits` in
   `shared/relay-mux.ts:357-368` copies known keys only). Its `nonce` (32 random bytes, base64url)
   is new for every session.
3. **HELLO** (machine) offers and requires the feature `pipe-stream`. A controller without the
   fleet extension answers `unsupported_extension`, as for any required feature it cannot select.
   A HELLO that offers `pipe-stream` beside a device feature (`pair-sas`, `pair-intent-*`,
   `account`, `large-ws-messages`, `server-time-header`, `relay-hints`, `direct-carrier`,
   `direct-tailnet`) is `protocol_error` (decided in todo 9: a machine is never a device, so a
   session cannot ask to be both). So is a HELLO that offers `pipe-stream` without requiring it
   (decided in todo 21: it asks for neither a machine session, which requiring makes, nor a device
   session, which never offers it). The controller does not select `pipe-stream` in WELCOME, which
   may precede HELLO; requiring it in HELLO is the negotiation.
4. **ENROLL / ENROLL_OK** (only while the machine holds an invite and no machine id; section 4),
   then on the same session:
5. **AUTH** `{scheme: "machine-key", machine_id, signature, seen_state?}`.
   - The machine key is an ECDSA P-256 key made on the machine; it never leaves it.
   - `machine_id` is the lowercase hex of the first 16 bytes of SHA-256 over the key's
     SubjectPublicKeyInfo DER (91 bytes): the key's **fingerprint**, the same 32 hex digits todo 30
     shows (decided in todo 9: both ends compute it from the key alone, a same-key ENROLL retry gets
     the same id, and a re-enrolled slot gets a new one).
   - The signed bytes, 113 in all:

     ```
     "ovis-fleet-auth/1" (17 ASCII bytes) || WELCOME nonce (32 raw bytes)
       || controller server_id (32 ASCII bytes: its 32 lowercase hex digits) || channel binding (32 raw bytes)
     ```

     signed with ECDSA P-256 / SHA-256; `signature` is the raw `r || s` (64 bytes) in base64url, as
     the device AUTH (`shared/relay-device.ts:73-84`). A verifier accepts either form of `s`
     (WebCrypto signers produce both). The domain `ovis-fleet-auth/1` differs from the device's
     `ovis-relay-auth/1`, so neither signature can stand for the other.
   - Why a replay fails. **Another connection**: its WELCOME nonce and its binding (fresh Noise
     ephemerals) differ. **Another controller**: its `server_id` and its static key (inside the
     binding) differ, and it cannot finish the NK handshake as this controller without this
     controller's private key. **After the controller rotates its key** (`rotateRelayIdentity`,
     `server/relay/identity.ts:63-65`): a new `server_id` and a new static key, so neither part
     matches, and the machine's pinned key refuses the new controller anyway until it is invited
     again (`--slots-from`, todo 31). **After a machine key is replaced**: the old key's
     `machine_id` is revoked (`auth_revoked`), and the new key's signature is checked only against
     the new id. auth.json holds a refused case for each: wrong nonce, wrong `server_id`, wrong
     binding, a rotated controller, a wrong key, the device domain, and a truncated signature.
   - `seen_state {generation, tag}` (optional): the newest FLEET_STATE the machine received from
     this controller, presented as it came (todo 31 fills it). The controller checks
     `tag = HMAC-SHA256(witness_key, server_id (32 ASCII bytes) || generation (8 bytes, unsigned
     big-endian))` (decided in todo 9: the byte form of the plan's `server_id || generation`); a
     tag that does not verify is ignored, never an error. It is not signed by the machine: only the
     controller can make a tag, and the channel keeps anyone from altering it.
   - The machine sends nothing after AUTH until AUTH_OK or SESSION_ERROR. A machine session never
     uses `early_open` (FD-9, todo 38: devices only), and the controller acts on no frame of it
     before it has verified AUTH and sent AUTH_OK.
6. **AUTH_OK** `{session_id, machine_id, role: "machine", relay_pace?, direct?, pending?}` (decided in todo 9: a
   machine has no `device_id`, so AUTH_OK names the `machine_id` instead, and the engine's
   `deviceId` stays unset so no HTTP or WS open is ever admitted, todo 20). `relay_pace` carries
   the fields of PACE (todo 37, "The relay pace" in section 5), sent to every machine; its `rtt_ms` is the time from
   WELCOME out to AUTH in (the AUTH signs WELCOME's nonce, so it is a round trip at least), and a PACE with a measured
   keepalive round trip follows the sign-in.
   `direct` (todo 29) names the controller's direct carriers for this machine (section 5, "Direct
   carriers"), left out when it has none; the agent dials them from then on and saves them in
   fleet.json. `pending: true` (todo 28) says the controller holds the machine `pending`: enrolled, signed in, and
   waiting for the owner to confirm its batch, so no pipe opens to it; only `true` is ever written and any other
   value is `protocol_error`. A controller that does not send it is read as before (not pending). When the batch
   is confirmed the controller ends such a session with GOAWAY `shutdown`, reason `confirmed` (drain 1 s; it holds no pipe), and the
   agent's next sign-in has no `pending`.
7. **FLEET_STATE** `{generation, tag}` (controller to machine only): sent after AUTH_OK and to every
   connected machine after each rise of the controller's witness generation (todo 31), only to a session whose
   AUTH `features` lists `fleet_state` (an agent from before todo 31 does not, and is sent none: it keeps working and
   takes no part in restore detection). The machine keeps the newest one and presents it in its next AUTH.
8. **PIPE_ADVERT** `{endpoints, runtime_id, boot_id, bridge_token?, native_bearer?, health, now,
   versions}` (machine, after AUTH_OK, again whenever any field changes). `endpoints` lists what
   the controller may open: `bridge` (a TCP connection to the machine's loopback Ovis bridge
   server) and `native` (a connection to the runtime's Unix socket). `bridge_token` is present
   exactly when `bridge` is listed, `native_bearer` exactly when `native` is. The two secrets
   travel only inside the encrypted channel, are kept in memory by the controller, never on disk,
   and each advert replaces the previous one whole; the controller drops a machine's advert when
   its session ends (decided in todo 9: without a session no pipe can open, so nothing needs it).
   `now` is the machine's clock in seconds, used only to show a `clock_skew` warning;
   `versions` names the four binaries for todo 59.

A refused sign-in or enrolment ends the session with SESSION_ERROR. On a machine session its
`message` is one of these causes, so the link agent can report why (todo 34) without parsing prose
(decided in todo 9: the code list in `shared/relay-mux.ts:89-93` is shared and stays as it is). A
link agent that reads another message treats it as the code alone.

<!-- contract:causes -->
| Code | Message | When |
| --- | --- | --- |
| `auth_failed` | `signature` | an AUTH or ENROLL signature that does not verify over the bytes the controller builds, or an ENROLL machine key that is not a P-256 point |
| `auth_failed` | `unknown` | an AUTH `machine_id` or an ENROLL `invite_id` the controller does not hold |
| `auth_failed` | `expired` | an ENROLL for an invite past its `exp` on the controller's clock |
| `auth_failed` | `rate_limited` | an ENROLL whose signature does not hold, beyond `enroll_tries_per_invite`, or from a direct carrier's source address beyond its refusals (section 4) |
| `auth_failed` | `wrong_scheme` | AUTH `device-key`, PAIR or PAIR_REQUEST after a HELLO that offered `pipe-stream`; AUTH `machine-key` after one that did not |
| `auth_failed` | `restored` | a sign-in while the controller holds its fleet as rolled back (todo 31) |
| `auth_failed` | `fleet_token_required` | an AUTH or ENROLL while the controller has no `OVIS_TOKEN` (todo 60, `server/fleet/gate.ts`): refused before the signature, the invite or the store is looked at, nothing counted or written; temporary, so the link agent keeps dialing on its backoff |
| `auth_revoked` | `revoked` | a key removed, revoked or replaced (todo 31), at sign-in or live |
| `auth_revoked` | `quarantined` | a slot or machine in quarantine (todo 30): a second key on one invite, or one key in two sessions that both answer a PING past the switch window |
| `resource_exhausted` | `controller_limit` | `OVIS_FLEET_MAX` machines (100 unless set, at most 1000) hold a session already, or this machine holds two (a switch under way), at sign-in; on a relay link, its machines already fill the room's fleet share (`max_clients` of the relay's `sync` minus the 8 device places: none in a room of 8), at sign-in or when a later `sync` names a smaller room (the newest go); an ENROLL past `OVIS_FLEET_MAX` machines (todo 30) |

### Causes shown on a machine row (todo 34)

`GET /api/fleet/machines` answers `{machines: [...]}`, one row per machine of the store: `machine_id`, `name`,
`slot`, `state` (the store's), `online`, `cause` (a code of `shared/fleet-cause.ts` or null), `message` (its English
sentence, null with it), `since` and `warnings` (causes that leave the machine working). `since` is ms since the epoch:
when the store changed the state, when the advert's health last changed (`runtime_down`, `bridge_down`), when the
cause was set, else when the session last signed in or ended, else when the controller started. `route` (todo 33) is
`direct` or `relay`, how the newest signed-in session came, and null while none is signed in; `last_seen` is ms since the
epoch, now while a session is signed in, else when the last one ended, null when none was since the controller started
(sessions are kept in memory only). It names no key, token,
bearer, forward port, socket path or invite. Any caller with full access may read it, a watching device included, directly
or through the relay; a Portal visitor and an open LAN window get `403 owner_only`, a page of another site `403
invalid_origin`, and a machine session has no route. Any other method answers `405 method_not_allowed`, and a store file
that was refused `503 fleet_store_unreadable`, in the usual `{error: {code, message}}` body. A reader that meets a cause
it does not know reads `offline`. A machine signed in whose advert has not come (or never does) shows `online: true`
and no cause: the controller knows nothing more, and no pipe can open until it does.

| Cause | Where it comes from |
| --- | --- |
| `pending_confirmation`, `quarantined`, `revoked` | the store's state of the machine |
| `runtime_down`, `bridge_down` | `health` of the machine's latest PIPE_ADVERT, while it is signed in (`runtime_down` first when both are down) |
| `clock_skew` | a warning when the advert's `now` differs from the controller's clock at the time the advert arrived by more than 5 minutes; never a refusal |
| `controller_limit` | a machine whose key verified and that the controller had no place for, until it signs in: `OVIS_FLEET_MAX`, or the relay room's fleet share (a room without a fleet allowance has none), at sign-in or when a smaller room ends the session |
| `fleet_token_required` | every machine but a revoked or quarantined one while the controller has no `OVIS_TOKEN` (todo 60): the fleet is held, nothing signs in and no forward opens; the reads also carry `fleet_state: "fleet_token_required"` |
| `reconnecting` | an active machine with no session that the controller expects back, for at most 30 s (`RECONNECT_MS`): its pending session was let go when its batch was confirmed (that session no longer counts as online while it drains), or the controller just started and the machine was seen within 10 min 30 s before it (a connected machine's `seen_at` is refreshed every sweep interval, 10 min, plus 30 s of slack for that timer). A launch (a pipe, the native route, a connection through the machine's forward) waits up to 10 s for its new session instead of using the one that is going, then answers `machine_unreachable` with this cause (the native route) or closes (the forward); a caller that hangs up during the wait ends it, and a machine revoked or removed during it is refused at once |
| `offline` | an active machine with no session and no other cause |
| `restored` | todo 31, through `Fleet.report` |
| `update_failed`, `version_mismatch` | todo 59, through `Fleet.report` |
| `relay_limit`, `relay_unreachable`, `disk_full` | no source, and no todo of the plan sets them: a machine the relay turns away never reaches the controller (only its own `ovis-link status` says `relay busy`), and nothing on a machine reports a full disk; `Fleet.report` is how one that does sets them |

The link agent keeps redialing a refused machine with its backoff, so a `controller_limit` row clears by itself when a
place frees. The agent's own `ovis-link status` says `refused: resource_exhausted (controller_limit)`, the same cause as
the row.

## 2. Pipes

- **Open.** Only the controller opens a pipe: PIPE_OPEN `{endpoint}` on stream id 2, then 4, each
  next id exactly 2 above the last (the plan's "even, from 2, strictly increasing"; consecutive as
  the client's odd opens are, `shared/relay-mux-engine.ts:1044`, decided in todo 9 so a GOAWAY
  watermark means the same on both kinds). PIPE_OPEN names only an endpoint, never an address:
  targets come from the agent's own configuration (todo 23). The machine answers PIPE_ACCEPT, or
  RESET `refused` for an endpoint it does not know or did not advertise in its latest PIPE_ADVERT,
  or when `max_pipe_streams` pipes are already open.
- **Data.** PIPE_DATA carries 1 to 16376 bytes. Each direction has a window of 768 KiB (786432
  bytes, `pipe_window_bytes`), opened when PIPE_ACCEPT is sent or received,
  and is credited by CREDIT (cumulative bytes consumed, u64) exactly as HTTP_DATA is
  (`shared/relay-mux-engine.ts:1069-1084`); traffic class interactive. DATA beyond the credit is
  `flow_control_error`; DATA before PIPE_ACCEPT, from either end, is `protocol_error`; an empty
  DATA is refused by the codec.
- **End.** PIPE_END (empty payload) half-closes the sender's direction; a pipe retires when both
  ends have sent PIPE_END, or at a RESET. A second PIPE_END in one direction, and DATA after it,
  are `protocol_error`.
- **Pace.** The engine ends a session `resource_exhausted` when its peer sends more than 4096 frames
  a second (a bucket of 8192) or opens more than 32 streams a second
  (`shared/relay-mux-engine.ts`). The link agent sends at most 3072 frames a second after a burst of
  2048, so carrier delays that bunch up to two seconds of its frames still fit the controller's
  bucket; a frame that would go faster waits in its queue, and its pipe reads nothing more from its
  target meanwhile. A machine opens no stream. It also keeps the receipt budget of
  [relay.md](relay.md) (408 KiB of ordinary and 16 KiB of control frames until RECEIVED).
- **Reset.** RESET on a pipe carries one of five codes; any other code there is `protocol_error`
  (decided in todo 9: both ends are Ovis code, and a code outside this list is a bug to surface).

<!-- contract:reset-codes -->
| Code | Sent by | When |
| --- | --- | --- |
| `refused` | machine | unknown or not advertised endpoint, `max_pipe_streams` reached, or opened past a GOAWAY |
| `internal_error` | either | the sender failed for a reason of its own |
| `upstream_lost` | machine | its target could not be reached or closed without ending (decided in todo 9: a failed connect is reported as this, not `refused`, which means the controller asked for something it may not have) |
| `slow_consumer` | either | its reader took nothing for 30 s while the window was full (`shared/relay-mux-engine.ts:828`) |
| `cancelled` | either | the pipe's user went away (the controller's local forward closed, or the operator stopped it) |

- **Local forwards** (`server/fleet/forward.ts`, todo 25). The controller gives each `active` machine a TCP
  listener on 127.0.0.1 at a port the system picks, every connection to it one `bridge` pipe, and a Unix socket
  `<n>.sock` (0600) in a folder of its own made with mkdtemp (0700) under the OS temp folder, every connection to
  it one `native` pipe (none on Windows). A forward opens pipes on its own machine only, on the newest signed-in
  session whose latest PIPE_ADVERT names the endpoint; with none, a connection closes at once (a TCP reset) and
  reads nothing. A 17th connection waits up to 30 s for a free pipe, trying again when the machine still answers
  RESET `refused` for a pipe the controller has retired. The controller paces what it sends under the machine
  engine's receive limits: opens at 24 a second after a burst of 32, pipe DATA at 3072 frames a second after a
  burst of 2048. A RESET on a pipe, or the session ending, resets the local connection; a local connection that
  goes before both directions ended resets its pipe `cancelled`. A TCP connection becomes a pipe only once its first
  request head carries `Authorization: Bearer <bridge_token>` of the machine's newest advert (compared in constant
  time, at most 16 KiB read within 10 s, todo 26); any other is closed before a pipe opens, so another local user
  cannot hold the machine's pipes. The head goes on unchanged: the bridge asks for its `bridge_token` again, and the
  runtime for its bearer, which the controller holds in memory only.
  A machine that leaves `active` (or its record) closes its forwards and deletes its socket and folder.
- **Carrier loss** resets every pipe locally as `upstream_lost`, with no frame
  (`shared/relay-mux-engine.ts:1297-1313`); nothing is sent again after a reconnect
  ([relay.md](relay.md), "Nothing is sent again").
- **GOAWAY.** In a machine session `last_open_id` is even or 0: the highest pipe id the sender has
  seen opened. The receiver resets its pipes above it `refused`. When the controller's next pipe id
  would pass `0x7ffffffe` it sends GOAWAY `id_exhausted`, and the machine opens a new session
  (decided in todo 9: the opener ends the id space, as a client does today).
- **Memory.** 16 pipes with 768 KiB receive windows reserve 12 MiB, exactly the engine's
  reservation per session (`MUX_RECEIVE_RESERVATION_BYTES`, [relay-mux-limits.md](relay-mux-limits.md)),
  so the 16th pipe still fits and the engine and its documented bound stay as they are. Re-deriving
  the 32 MiB bound for a machine session (which holds no HTTP or WS stream) gives 2 x 12 + 4 + 1 +
  1/16 + 424/1024 = 29.48 MiB. Throughput is not lower than with 1 MiB windows: the 408 KiB session
  flight cap binds first (decided by the owner on 2026-11-12, against 12 pipes or a 16 MiB budget
  for machine sessions). An end that cannot reserve a window answers the open with RESET `refused`,
  never a session error, so the wire behaviour stays defined.

## 3. What a machine session may never send

A machine is never a device: it may keep alive, advertise endpoints and answer the pipes the
controller opens, and nothing else. The controller ends the session with SESSION_ERROR and the
code below. `before_auth` is after HELLO and before AUTH_OK; `after_auth` is after AUTH_OK.

<!-- contract:never-from-machine -->
| Frame | When | Answer |
| --- | --- | --- |
| `HTTP_OPEN` | any | SESSION_ERROR `protocol_error` |
| `WS_OPEN` | any | SESSION_ERROR `protocol_error` |
| `PAIR` | before_auth | SESSION_ERROR `auth_failed` |
| `PAIR` | after_auth | SESSION_ERROR `protocol_error` |
| `PAIR_REQUEST` | before_auth | SESSION_ERROR `auth_failed` |
| `PAIR_REQUEST` | after_auth | SESSION_ERROR `protocol_error` |
| `PIPE_OPEN` | any | SESSION_ERROR `protocol_error` |
| `PACE` | any | SESSION_ERROR `protocol_error` |
| `FLEET_STATE` | any | SESSION_ERROR `protocol_error` |
| `ENROLL` | after_auth | SESSION_ERROR `protocol_error` |
| `ENROLL_OK` | any | SESSION_ERROR `protocol_error` |
| `PIPE_ADVERT` | before_auth | SESSION_ERROR `protocol_error` |
| `AUTH` | after_auth | SESSION_ERROR `protocol_error` |
| `HELLO` | after_auth | SESSION_ERROR `protocol_error` |
| `UNASSIGNED` | any | SESSION_ERROR `protocol_error` |

`UNASSIGNED` is any type of `0x49`-`0x4f`, with the fleet extension registered: its codec reads none of
them, so the decode fails.

HTTP_OPEN and WS_OPEN fail the engine's own OPEN check (`shared/relay-mux-engine.ts:1079`): a machine
session is signed in through the engine's second authenticated state (`authenticateExtension`), in
which no device id is set, so no OPEN is ever admitted. PAIR, PAIR_REQUEST, AUTH and HELLO after
sign-in fail its setup check (`:1074`, and `:1046` for an AUTH the extension reads), which refuses
every setup frame once either a device or an extension's principal is signed in. Before sign-in,
after a HELLO that offered `pipe-stream`, PAIR, PAIR_REQUEST and AUTH `device-key` are refused by
`server/relay/session.ts` with `auth_failed` and the cause `wrong_scheme`, before the pairing code,
the pairing window or the device store is looked at, so no approval prompt is ever shown and no
pairing failure is counted for a machine. No device row is ever made for a machine.
`server/relay/machine-session.contract.test.ts` runs every row of this table against a live session
and checks that `devices.json` stays byte-identical.

The link agent holds the controller to the same rule and closes with `protocol_error`:

<!-- contract:never-from-controller -->
| Frame | When | Answer |
| --- | --- | --- |
| `HTTP_OPEN` | any | SESSION_ERROR `protocol_error` |
| `WS_OPEN` | any | SESSION_ERROR `protocol_error` |
| `PIPE_ADVERT` | any | SESSION_ERROR `protocol_error` |
| `ENROLL` | any | SESSION_ERROR `protocol_error` |
| `PIPE_ACCEPT` | any | SESSION_ERROR `protocol_error` |
| `PIPE_OPEN` | before_auth | SESSION_ERROR `protocol_error` |
| `PACE` | before_auth | SESSION_ERROR `protocol_error` |
| `FLEET_STATE` | before_auth | SESSION_ERROR `protocol_error` |
| `UNASSIGNED` | any | SESSION_ERROR `protocol_error` |

## 4. Invites and enrolment

**The invite file** (JSON, UTF-8, mode 0600, at most 4096 bytes) is minted on the controller in
batches (todo 30) and carried to the machine by the operator:

```json
{"v":1,"id":"<16 hex>","slot":<0..65535>,"controller":{"server_id":"<32 hex>","server_public_key":"<base64>","relay":"wss://...","direct":["ws://<host>:<port>"]},"owner":{"public_key":"<base64url, 32 bytes>","member":{"v":1,"server_id":"<32 hex>","server_public_key":"<base64>","class":"opener","open":true,"write":true},"signature":"<base64url, 64 bytes>"},"secret":"<base64url, 32 bytes>","exp":<seconds>}
```

`server_id` must equal the id derived from `server_public_key` (`deriveServerId`,
`shared/relay-server-proof.ts:26-28`); `relay` is a `wss:` origin or `null`; `direct` holds at most
4 entries `ws://<host>:<port>`, where a host is a private or Tailscale IPv4 address
(`isDirectCarrier`, `shared/relay-mux.ts:348-350`) or a DNS name that the agent resolves at every
dial and uses only when it resolves to such an address (todo 30); at least one of `relay` and
`direct` is present (decided in todo 9: the formats of an offer and of AUTH_OK's `direct`, plus
names). `owner` is the fleet's owner key and the controller as the member it signed ("Owner key and members"
below): the record must verify under `owner.public_key` and name exactly `controller`'s key as a member that may
open. A file that breaks any of this is refused whole (`invalid_invite`), and so is one without `owner`. The
machine never judges `exp`: only the controller's clock does.

**The invite as one line** (`ovis fleet invite --line`, for pasting into a terminal or a cloud-init field):
`ovis-invite:1:` and then the invite file's exact bytes in canonical unpadded base64url (RFC 4648 section 5: no `=`, no
`+` or `/`, the unused bits of the last symbol zero). A reader drops the ASCII spaces, tabs and line ends around it,
refuses anything longer than 5476 bytes (the prefix and 4096 bytes of file), any other prefix or version, and any symbol
or padding outside that form (`invalid_invite`), then reads the bytes it decoded as the invite file, through the same
reader: a line is never more than its file. The line holds the secret as the file does. Readers: `inviteLineBytes` /
`parseInviteLine` beside `parseInvite` (`server/fleet/invites.ts`) and `invite::decode_line` in `crates/fleet-link`,
both checked against the `INVITE_LINE` cases of invite.json.

**The invite key.** The `secret` never leaves the machine and is never kept by the controller,
which holds it only while it writes the invite file. Both ends derive from it an Ed25519 key pair
whose RFC 8032 seed is

```
seed = HKDF-SHA256(ikm = secret (32 bytes), salt = empty, info = "ovis-fleet-invite/1" || invite id (16 ASCII bytes), length = 32)
```

The controller stores only the public key (`invite_public_key`, 32 bytes, kept as 64 hex digits
like the relay pass keys of `shared/relay-pass.ts:107-112`) with the id, slot, expiry and batch.

**ENROLL** `{invite_id, machine_public_key, signature, now}` (machine, on a protected channel,
before any AUTH): `machine_public_key` is the new machine key's SPKI DER in base64url (91 bytes,
as PAIR's `public_key`), `now` the machine's clock in seconds (advisory, `clock_skew` only), and

```
signature = Ed25519(invite private key, "ovis-fleet-enroll/1" (19 ASCII bytes) || channel binding (32)
                    || machine public key SPKI DER (91) || invite id (16 ASCII bytes))
```

in base64url (64 bytes). The controller checks the id, then the expiry, then the signature against the
stored public key with this session's binding (WebCrypto verifies it as `shared/relay-pass.ts:141` does; the
try budget refuses only an ENROLL whose signature does not hold, so a valid one is never locked out), then the
state, records the machine `pending` and answers
**ENROLL_OK** `{machine_id}` (the fingerprint of `machine_public_key`, section 1). The machine then
signs in with AUTH on the same session. The same key retrying gets the same answer; a second key
for the same invite quarantines the slot (`auth_revoked`, `quarantined`); the controller opens no
pipe to a machine whose batch the operator has not confirmed (todo 30).

**On the controller** (`server/fleet/invites.ts`, todo 30). A mint (`POST /api/fleet/invites
{count?, prefix?, life_s?, direct_hosts?}`) makes 1 to 256 invites in one new batch, with at most 1024 unused and
unexpired at once; each lives 1 h unless `life_s` says otherwise (60 s to 24 h), takes the lowest free slot and the
name `<prefix><slot>` (`machine-` unless given). Its answer `{batch_id, count, exp, invites}` holds the invite files,
the only place a secret ever goes; the store (`<state>/fleet/machines.json`, beside the machines) keeps per invite only
`id`, `slot`, `name`, `batch_id`, `public_key` (`invite_public_key`), `exp`, `used_by` (the first machine key it
admitted) and `created_at`, and nothing else ever names a secret: no log, no error and no later answer. An invite's
`controller.direct` is the list a machine's AUTH_OK names (section 5, "Direct carriers") and then each
`direct_hosts` name on the same port; while an invite is unused and unexpired the fleet is in use, so the bridge
listeners are up before its file is written. A mint never touches an earlier invite; an invite is dropped from the
store 24 h after its expiry unless a machine still names it. `GET /api/fleet/invites` lists each invite with its
`state`: `unused`, `used` or `expired` (by the controller's clock). `POST /api/fleet/invites/withdraw` `{invite_id}` or
`{batch_id}` (todo 31) withdraws open invites: gone from the store, an ENROLL with one is refused `unknown`; an invite a
machine used stays with it (`invalid_request`), and an unknown id is 404 `unknown_invite` or `unknown_batch`.

ENROLLs pass one admission queue: every request whose signature held is decided, in order, against the store as it
is, and a turn of the queue is one store write, so a wave of machines neither loses one nor admits one twice. An
invite stops admitting a new key the moment it is used or expires; past `OVIS_FLEET_MAX` machines an ENROLL is
refused `resource_exhausted` `controller_limit`; a second key quarantines the machine the first key made (and the
slot with it) and raises an alert (the log line `fleet.quarantined`; `Fleet.onAlert`). A refusal writes nothing:
the try budgets live in memory. They are `enroll_tries_per_invite` refused ENROLLs per invite id, after which an
ENROLL whose signature does not hold is answered `rate_limited` (a valid one is still taken: knowing an invite id is
not enough to lock its machine out), and, on a direct carrier, 20 refused ENROLLs per source address in 10 minutes,
checked before anything else (only refusals count, so many machines behind one address still enrol); neither touches
the budget phones pair with. What a junk ENROLL costs is one Ed25519 check, bounded by the sessions a carrier
admits: one ENROLL per session, each after a Noise handshake.

**Confirming a batch.** `GET /api/fleet/batches` lists each batch with machines waiting: `{batch_id, created_at,
count, machines: [{machine_id, slot, name, fingerprint}], digest, invites: {unused, used, expired}}`, where
`fingerprint` is the machine id (the first 32 hex digits of SHA-256 over the key's SPKI DER) in groups of four and
`digest` is SHA-256, as 64 hex digits, over the batch's sorted machine ids (each 32 ASCII hex digits) one after
another. `POST /api/fleet/batches/<id>/confirm {count, digest}` makes exactly that set `active`, and answers 409
`batch_changed` (activating nothing) when a machine joined or left the batch since it was read; 404
`unknown_batch` for an id it does not hold. `GET /api/fleet/machines` names each machine's `fingerprint` and the
`batch_id` of its invite.

**Remove, revoke, vanish, rebuild** (todo 31). Every route here is a fleet write: an owner, the app's header, never a
watching device, a Portal visitor, an open LAN window or a machine session (server/fleet/routes-access.contract.test.ts).

- `DELETE /api/fleet/machines/<id>` revokes the machine: its fingerprint goes into the controller's witness (below)
  first, then the store marks it `revoked`. Its live sessions follow the store and end `auth_revoked` (`revoked`), every
  open pipe and its forward close, so it leaves the PC list; its programs keep running on the machine. The record stays
  as a tombstone (`GET /api/fleet/machines` lists it `revoked`); removing it again forgets the record (`state:
  "forgotten"`), and the witness keeps its key refused `auth_revoked` for good. 404 `unknown_machine` for an id the
  store does not hold.
- The vanish sweep (every 10 minutes): a pending or active machine that is not connected and was not seen for longer
  than its batch's retention is removed the same way and logged `fleet.vanished`. A batch's retention is set at minting
  (`retention_s`, `ovis fleet invite --retention`; 24 h by default, `0` keeps forever); a machine of no batch is kept;
  a quarantined one is left for the operator.
- A rebuild: `POST /api/fleet/invites {slots_from: <batch>, life_s?, retention_s?}` (`ovis fleet invite --slots-from`)
  mints one invite for every slot of that batch under the slot's name. A machine that enrols with one replaces the
  slot's old key, which is revoked into the witness (`fleet.re-enrolled`); its new machine id waits for its batch to be
  confirmed. A rebuild is refused `invalid_request` while a slot still has an open invite. For a controller that got a
  new key the same command names the new key in every invite.
- `POST /api/fleet/slots/<slot>/release` is the only way out of a quarantine: the slot's quarantined key is revoked, and
  the slot may then be enrolled again with a rebuild's invite (until then such an ENROLL is refused `quarantined`).
  404 `unknown_slot`, 409 `slot_not_quarantined`.
- On the machine, `ovis-link leave --state <dir>` deletes its machine key and fleet.json (refused while `ovis-link run`
  holds the folder). The controller is not told: remove the machine there.

**The witness and a restored state folder** (todo 31). A state folder put back from a backup carries its own markers,
so nothing inside it can show that it is older than the fleet, and a key removed after the backup is back in it. The
controller keeps a witness outside the folder: `fleet-witness/<id>.json` under the user's state home
(`$XDG_STATE_HOME/ovis/`, default `~/.local/state/ovis/`; `~/Library/Application Support/ovis/` on macOS;
`OVIS_FLEET_WITNESS_DIR` names the folder), mode 0600 in a 0700 folder, written atomically and synced before the store:
`{v, server_id, generation, witness_key, removed: [{fingerprint, at}], quarantined: [{fingerprint, at}]}`. The id is the controller's server_id when its
first witness was made, recorded in the store (`witness_id`) so a rotated relay identity keeps it. `generation` rises by
one with every removal, revocation, quarantine, sweep and slot replacement, and the store records the generation it was
written at; `removed` keeps every key removed, revoked or replaced, and `quarantined` every key in quarantine until its slot is
released (at most 4096 each: past that a removal is refused 409 `witness_full`). A key either list names is refused at
sign-in (`auth_revoked` `revoked` or `quarantined`) and at ENROLL with any invite (the invite stays unused), whatever
the store says, so neither a forgotten tombstone nor a restored store lets it back. A witness that cannot be written fails the change with 503 `witness_write_failed` and changes nothing.
After AUTH_OK, and to every connected machine after each rise, the controller sends FLEET_STATE (section 1.7); the link
agent keeps the newest in fleet.json (`seen_state`) and presents it in its next AUTH.

The controller holds its fleet as rolled back when the witness's generation is above the store's, when the witness is
missing (or unreadable) while a store written under one holds machines, when it started with `OVIS_FLEET_RESTORED=1`,
or when a machine presents a `seen_state` whose tag verifies and whose generation is above the store's. A verified
generation above the witness's own is written into the witness at once, so the confirmation rises to it: the machine
that proved it signs in after the confirmation, and only a proof above the confirmed generation holds the fleet again. Then every
machine sign-in is answered `auth_failed` `restored`, no forward opens, every row shows the cause `restored`, and the
hold is kept in the store across restarts. A key the witness lists is refused `auth_revoked` at all times. `GET
/api/fleet/machines` then also answers `restore: {notice, reason, store_generation, witness_generation, digest}`, and
each row `removed_after_backup`; `POST /api/fleet/restore/confirm {digest}` (`ovis fleet confirm --restored`) confirms
that list (409 `restore_changed` when it changed, 409 `not_restored` when nothing is held), raises the store to the
witness's generation and lets the machines in, except the removed ones: `POST /api/fleet/machines/<id>/readmit` (`ovis
fleet readmit`) takes one key off the witness's list (409 `not_removed` otherwise). Moving a controller to another PC
means moving its state folder and its witness file; after restoring a whole-disk snapshot, which brings an old witness
back too, start once with `OVIS_FLEET_RESTORED=1`: without it, only a machine that saw a newer generation reveals the
rollback, and a removed machine alone cannot.

**Without a token** (todo 60, `server/fleet/gate.ts`; [docs/fleet.md](fleet.md#where-the-controller-runs)). While the
server has no `OVIS_TOKEN` every fleet write (`POST /api/fleet/enable`, `POST /api/fleet/invites`, `POST
/api/fleet/batches/<id>/confirm`, `DELETE /api/fleet/machines/<id>` and any later one) answers 409
`fleet_token_required` and writes nothing, whoever asks; so does the owner-key step (`ovis-server fleet owner`, `ovis
fleet on`). A machine's AUTH and ENROLL end `auth_failed` `fleet_token_required` (section 1) and no forward opens. The
reads (`GET /api/fleet/machines`, `/invites`, `/batches`) keep answering, and while a fleet that was turned on is held
they carry `fleet_state: "fleet_token_required"`. With a token, `server/access.ts` decides as always: a loopback caller
without it gets 401 `token_required`, a device paired to drive writes through the relay without it, one that watches
gets 403 `read_only`. `POST /api/fleet/enable` (owner only, as every write) turns the fleet on by writing
`<state>/fleet/enabled`, as the first mint does; it makes no owner key, whose phrase never goes over HTTP. A fleet counts as
turned on once that marker, the owner key or the machine store exists; a server started with no token whose fleet is on
logs one line saying it is held. Restarted with its token, its machines sign in again with no new invite.

The store itself is closed while the fleet is held: `FleetStore.update`, the one path every change of machines,
invites and batches takes, refuses with `fleet_token_required` before it touches the lock or the folder, whoever calls
(a route, a sign-in, a sweep, a start-up backfill), so a writer added later meets the gate without a check of its own; a
writer that runs at start-up does nothing on a held fleet and runs once the server starts with its token. A pending
machine of a held fleet is answered `fleet_token_required` like any other, before anything about `pending`.

**`ovis fleet`** (`scripts/plugin-fleet.ts`; from source `bun scripts/plugin.ts fleet`): the owner's command line on
the controller, through these routes with the address and token every `ovis` command uses (loopback; the plugin's
`OVIS_TOKEN` when one is set). `on [--phrase-file <path>]` is `ovis-server fleet owner` (the phrase only on a terminal or
in a new 0600 file, never in `--json`); `invite --out <dir> [--count N] [--prefix P] [--ttl 1h]` writes one 0600 file
`<dir>/<id>.json` per invite (its canonical bytes; a file that holds anything is never overwritten) and prints ids,
names and expiry, never a secret. A folder it cannot write is refused before anything is minted (`out_not_writable`,
exit 1), and the folder is made only after a mint succeeded; a file that cannot be written after the mint
(`write_failed`, exit 1) or whose name is taken (`file_exists`, exit 2) leaves no part of it behind, and the error
names the batch, the files written and the ids not written (`--json`: `{"error":{code, message, batch_id, exp,
written, unwritten}}`), which expire unused; `invite --line` prints the line form instead, only to a terminal or with
`--force-stdout`; `list` shows machines, open invites and batches waiting; `confirm <batch> [--yes]` shows the count
and fingerprints, asks on a terminal, sends the count and digest, and reports a 409 as changed without trying again;
`remove <machine>` takes an id, a fingerprint or a name only one machine has. Todo 31 adds `invite --retention <dur>`,
`invite --slots-from <batch>`, `invite --withdraw <invite>` and `invite --withdraw --batch <batch>`, `release <slot>`,
`readmit <machine id>`, `confirm --restored` (shows the restore notice and its list, asks, sends the digest), and `on
--restore`, which puts the owner key back from its recovery phrase, read at a terminal prompt or from `--phrase-file`
(a regular file of mode 0600; never an argument), and never replaces another owner key. `on` writes and syncs the
phrase first (a temporary file, linked under its name, the folder synced) or shows it on the terminal, and only then
links the key: a crash leaves no key, or the phrase without the key, which running `on` again with the same
`--phrase-file` finishes; never a key without its phrase. Every command has `--json`. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | done |
| 1 | failed (an answer it cannot read, a file it cannot write) |
| 2 | usage, or a rule of the command (no terminal for a secret, an existing file) |
| 3 | no such machine or batch, or a name that more than one machine has |
| 4 | no Ovis server answers at the `ovis` commands' address |
| 5 | the fleet is not on (`owner_key_missing`) |
| 6 | refused by the server (token, owner rule, no carrier), or not confirmed at the prompt |
| 7 | the batch changed since it was shown (`batch_changed`): nothing was confirmed |
| 8 | the server has no `OVIS_TOKEN`, so its fleet is held (`fleet_token_required`): nothing was changed |

A command whose server asks for a token that the plugin's config does not hold (run as another user, or with
`env -i`) ends with exit 6 and `cannot read the server token`; `list` prints the held state of a fleet without a token
first (`fleet_state` in `--json`).

**`ovis start` and `ovis wait`** (`scripts/plugin-start.ts`; from source `bun scripts/plugin.ts start|wait`; todo 32):
an orchestrating agent on the controller starts a program with its first message on a named machine, and waits for a
terminal's shown state, through the machine's bridge server (todo 27) behind the controller's loopback `bridge`
forward (section 2). `ovis start` with no arguments still starts this PC's Ovis server.

```sh
ovis start vm-001 --agent claude --cwd /tmp --message 'hi' --wait 30 -- claude
ovis wait vm-001 t3 --until idle,blocked,done --timeout 600
```

- Both name the machine as `ovis fleet` does and read `GET /api/fleet/machines/<id>/bridge`, the same rule as
  `/native` (a process on the controller with the token in its Authorization header): `{machine_id, name, port,
  token}`, the forward's loopback port and the bridge token of the machine's newest advert. The token goes into one
  request header and is never printed or logged.
- `start` posts `POST /api/workspace/create` `{program: {argv, agent?}, cwd?, env?, first_message?,
  first_message_wait_ms?}` to the bridge. A bridge on herdr or herdr-core runs no program that way and answers 409
  `unsupported_runtime`. It prints `{terminal, pane_id, first_message: {state, ready_by | code}}` and exits 0 when
  the message was sent (or none was asked for), 5 when it was held.
- `wait` opens the bridge's status stream (`/ws` with the bridge token: its snapshot, then each pane's status),
  finds the terminal by its pane id or terminal id (an address for a program `start` ran), and prints `{state,
  derived, basis}` once its shown state is one of `--until` (`idle`, `blocked`, `done`, `working`): `basis` is the
  `basis.kind` of the root record's report (`status_basis` of the snapshot's pane), `derived` is true for a screen
  basis. Exit 0; 124 when `--timeout` passes first; 3 (`terminal_ended`) when the terminal's program ends by itself
  first (the bridge's `pane-exited`). A terminal already finished is not in the snapshot: 82 `unknown_terminal`. Known
  limit: a terminal someone killed sends no `pane-exited` (herdr's rule), so without `--timeout` that wait goes on.
- Their own failures exit with these codes (81 usage, 82 unknown machine or terminal, 83 unreachable, 84 fleet
  off, 85 not running, 86 refused, 80 anything else) and `ovis start:` / `ovis wait:` on stderr, or the `--json`
  record with that `origin`.
- The runtime's `agent.note` and `agent.wait_children` are not served, and a machine can open nothing toward the
  controller, so a parent on the controller always waits by calling (`ovis wait`).

**On the machine** (`crates/fleet-link`). While `fleet.json` holds an `invite` `{id, secret}` (copied by the
installer from the invite file, todo 28), `ovis-link run` sends ENROLL right after WELCOME and AUTH only once
ENROLL_OK came, on the same session; it then removes `invite` from fleet.json (0600, synced, one rename, every
other key kept) and enrols no more. A machine that is `pending` signs in with an AUTH_OK that says `pending`, and
`ovis-link status` says `pending-confirmation` until a sign-in's AUTH_OK no longer does (its row on the controller
says `pending_confirmation`). Against a controller that does not send `pending` it says `connected`, as before.

**Why this design.** It verifies from what the controller keeps on disk, so an invite minted
before a controller restart is redeemed after it; a copy of the controller's store holds public
keys only and enrols nothing; no secret crosses the wire, and each signature covers its own channel
binding, so whoever takes the controller's place with a stolen controller key collects no proof
that works anywhere else. Rejected: an HMAC keyed by the secret (the controller would have to store
the secret, and a stolen store would enrol machines), and the secret sent inside the channel
against a stored SHA-256 (it verifies, but the secret leaves the machine and reaches whoever holds
the controller key). enroll.json fixes a secret with its derived seed, public key and signatures,
which Ed25519 makes deterministic, and refused cases for a wrong secret, another machine key, a
replay on another session, an unknown or expired invite, the try budget and a truncated signature.

### Owner key and members

A machine pins the fleet's OWNER key, not one controller. The owner key is an Ed25519 key made once per fleet, by an
explicit step of its own that turns the fleet on: `ovis-server fleet owner [--phrase-file <path>]` on the controller
(`server/fleet/cli.ts`; from source `bun server/fleet/cli.ts owner`). Its secret half is `<state>/fleet/owner.json`
(0600, written once and never replaced). The step shows the key's recovery phrase once (Crockford base32 of the
32-byte seed and 2 check bytes, in groups of four): on stdout when stdout is a terminal, else only into the new file
`--phrase-file` names (made mode 0600, refused if it exists), else it makes nothing. The phrase is never in an HTTP
answer, a log line or an error; a second run makes no second key and shows no phrase. Minting invites before this step
is refused 409 `owner_key_missing`. Restoring the key from the phrase is a later todo's. Every invite carries `owner`: the owner
key's public half and one MEMBER record it signed, `{v, server_id, server_public_key, class, open, write}`, naming the
controller's own static key with `class` `opener`, `open` and `write` true. The signature is Ed25519 over
`"ovis-fleet-member/1"` and the record's canonical JSON (field order as written, compact). `class` is `opener` or
`worker` today; a later version adds `answer_only`, which nothing reads yet. The invite, fleet.json and the member
record each carry `v` 1; a reader refuses any other (`invalid_invite`, `invalid_fleet`).

The installer copies `owner` into fleet.json beside the pinned controller. The link agent checks it at every start,
and so before any enrolment: the record verifies under `owner.public_key` and names exactly `controller`'s key as a
member that may open; otherwise it refuses the file `controller not signed by the owner key` (the vectors'
`controller_not_member`) and dials nothing. That covers a record another key signed and a controller key that changed
(rotated) without a new record the owner key signed. A fleet.json or an invite without `owner` is refused: nothing
without it has shipped. With one member nothing visible changes: the agent still finishes its handshake only with
`controller.server_public_key`.

What a later member list adds (not in this version): more members signed by the owner key, sent to machines over a
new frame, so a second controller is added, or the first replaced, without enrolling any machine again; the agent then
dials every member that may open. Removing members and syncing the list are later todos.

## 5. Carrier loss, controller restart, runtime restart

- **Carrier loss** (either end): the engine resets every pipe `upstream_lost` with no frame; the
  agent ends each copy to its target; the controller ends the local forwards on that machine and
  drops its advert. Nothing is resent. The machine dials again (backoff of todo 24, the relay pace
  of todo 37) and runs the whole of section 1 anew: new nonce, new binding, new AUTH, new
  PIPE_ADVERT.
- **Planned switch** (relay to direct, todo 29): the machine opens and signs in the new session
  before it closes the old one, as the app proves a carrier before it moves
  ([relay.md](relay.md), "The app moves on its own"). A pipe is never moved: new pipes open on the
  newer session, old ones finish or reset with the old session. When a machine still holds two sessions at the end
  of the 10 s switch window, the controller sends a PING on each (todo 30): a session that does not answer within
  5 s is a dead carrier (a half-open link, whose machine has already dialed again) and is ended `timeout`, and the
  machine keeps the other one and stays `active`. Only two sessions that both answer (two live holders of one key: a
  cloned image) quarantine the machine: both end `auth_revoked` `quarantined` and an alert is raised, so the newer one
  never simply wins. A relay or anyone on the path cannot answer for a session: a PONG travels inside the channel. A
  third session is refused at once `resource_exhausted` `controller_limit`.
- **Controller restart**: every machine session ends as a carrier loss. The store on disk keeps
  machines and invite public keys, so machines sign in again and invites minted before the restart
  are still redeemed; secrets of adverts are gone and come back in each new PIPE_ADVERT. After
  AUTH_OK the controller sends FLEET_STATE (todo 31) and, in AUTH_OK, `relay_pace` (todo 37).
  How many machines sign in at once and in what order: "Many machines at once" below.
- **Runtime restart on a machine**: its `boot_id` and `native_bearer` change; the agent resets
  every open `native` pipe `upstream_lost` and sends a new PIPE_ADVERT. A bridge restart does the
  same for `bridge` pipes and `bridge_token`. The machine session itself stays up.
- **Machine reboot**: a carrier loss followed by a new session.

### The link agent: `ovis-link run` (todo 24)

`ovis-link run --state <dir>` is the machine's long-lived agent, run by a systemd user unit or a
LaunchAgent (todo 28). It listens on no port. It holds an exclusive lock on `<dir>/run.lock` for
as long as it runs (a second one exits 7) and reads these files of `<dir>`, each through one
private-file reader: a regular file of mode 0600 or stricter, opened with
`O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` (no symbolic link, no FIFO or device that could block, no
terminal that could become its controlling terminal), checked on the same descriptor, at most 16
KiB.

- **`fleet.json`** (written by the installer from the invite, todo 28; `FLEET_FILE` in the fields
  table, vectors in machine-files.json): the controller's `server_id` and pinned
  `server_public_key`, its relay and direct carriers, the fleet's owner key with the controller as the member it signed
  ("Owner key and members", checked at every start), and the machine key file. A `server_id` that
  is not the one derived from the key is refused as `controller key mismatch` before anything is
  dialed. Everything the agent dials comes from this file: nothing from the wire chooses a host, no
  redirect is followed, and the agent never falls back to an unpinned key. It is read once, at start:
  an edit takes effect when the agent restarts. The one thing the agent writes back is
  `controller.direct`: when a session's AUTH_OK names direct carriers other than the ones it dials,
  it dials those from then on (a session the relay carries probes them after 5 minutes, as below)
  and replaces that list in fleet.json (0600, synced, one rename), every other key kept as it was.
  It writes nothing when the file names another controller by then, or when the result would be
  refused at the next start; a write that fails leaves the new list in memory until a restart.
- **`advert.json`** (written by the machine's bridge server, todo 27, replaced in one rename after
  every runtime or bridge restart; `ADVERT_FILE`): what PIPE_ADVERT names. `bridge` is offered
  with `bridge_port` and `bridge_token`, `native` with `native_bearer`. `health.bridge` is `down`
  when 127.0.0.1:`bridge_port` does not accept a connection (tried when the file changes and every
  30 s), `health.runtime` when the file says `runtime_down`. The agent looks at the file once a
  second (a `stat`; it reads only when size, time or inode changed): a bounded poll rather than
  inotify or kqueue, because the two differ, a file replaced by rename needs its folder watched,
  and one `stat` a second costs nothing. A changed advert goes out at once on every live session
  and replaces the last one whole; pipes to a target it changed (a new `boot_id`, bearer, token,
  port or socket) end `upstream_lost`. With no usable advert.json, no advert goes out and every
  PIPE_OPEN is refused.

  The bridge server that writes it is `ovis-server remote` with `OVIS_FLEET_BRIDGE=1`
  ([fleet-product-bridge.md](fleet-product-bridge.md)). It listens on
  127.0.0.1 only and never starts the relay: `POST /api/relay/start` answers 409 `relay_unavailable`. One fleet
  state folder has one bridge: a second one stops before it starts anything or writes the file. It writes advert.json into `$OVIS_FLEET_STATE`, which defaults to
  `$OVIS_FLEET_HOME/state`, the folder `ovis-link run --state` reads. The file names the runtime's socket and owner
  bearer, `boot_id` (the runtime's boot id) and `machine_id` (the runtime's own machine id, which the agent does not
  read). After every runtime restart it is written again, because each runtime boot has a new bearer. While the
  runtime does not answer it says `runtime_down`. `runtime_id` is the PC's own Ovis id (`web_ui.server_id`, the id
  its own Ovis server reports) when the PC has one, and the runtime's machine id otherwise. The controller's roster
  uses that id to show a fleet machine that is also an SSH or relay PC as one row naming both routes.
  One limit: a fleet machine that reports another PC's id hides its own row inside that PC's row, labelled "through
  the fleet link". It never receives that PC's traffic, because each route keeps its own connection.
- **`status.json`**, written by the agent (0600, replaced in one rename) and printed by
  `ovis-link status --state <dir> --json`: `state`, `path`, `error`, `peer`, `machine_id`,
  `advert`, `since`, `next_relay_dial`, in that order. `state` is `dialing`, `connected`, `pending-confirmation` (connected,
  and the session's AUTH_OK said `pending`), `waiting` (backoff),
  `stopped`, or `not_running` when no agent holds the lock; `path` is `direct` or `relay`; `error`
  is the class of the last failure (`controller key mismatch`, `controller not signed by the owner key`, `controller unreachable`, `relay
  certificate refused`, `relay busy`, `controller not answering`, `handshake refused`, `carrier
  lost`, `controller went away`, `keepalive timed out`, `protocol error`, `machine key refused`,
  `relay rate limited`, `controller busy`, `refused: <code> (<cause>)`, or a fleet.json refusal); `peer` is the controller's `server_id`;
  `advert` is `ok`, `missing` or why advert.json was refused; `next_relay_dial` is when the next relay dial is due
  (seconds since the epoch, null while connected or when none is armed), which `ovis-link status` prints as `(next
  relay dial in N s)`. It never holds a token, key or bearer.
- **`stopped`**: written (and synced, with its folder) when the controller refuses the machine
  `auth_revoked` (`revoked` or `quarantined`). While it exists the agent dials nothing, across
  restarts, so a retired fleet takes none of the controller's waiting places; `ovis-link rejoin
  --state <dir>` removes it and the agent dials again within a second. The refusal stops the
  running agent whether or not the mark could be written: when it cannot (a read-only folder, a
  full disk), the agent stays stopped in memory and keeps running, logs `ovis-link: stopped:
  authorization revoked; could not record it: <why>`, writes `; could not record it: <why>` after
  the refusal in `error` when status.json can still be written, and tries the mark again every
  second. Only a mark it saw on disk and then saw removed lifts the stop; until the mark is
  written, restarting the agent is what lets it dial again (and be refused again, if it still is).

**Dialing.** A round dials every direct carrier at once (`ws://<host>:<port>/v1/ws?v=1`) and gives
them 1.5 s to prove the controller: the upgrade, the `assigned` frame and the Noise handshake to
the pinned key. The first that proves it signs in; the others are closed. When the 1.5 s pass, or
every direct carrier failed sooner, the relay's client socket is dialed at the machine's next paced instant ("The
relay pace" below; at once for a machine that never held a pace):
`/v1/ws?server_id=<id>&role=client&v=1&lane=paced` (todo 35: a paced client never takes the PC's
warm socket and gives way first when a room's waiting queue is full). TLS to a `wss:` relay is
rustls (ring's primitives, no OpenSSL) verifying the certificate and host name against Mozilla's
root store as the `webpki-roots` crate ships it, built into the binary; the controller itself is
proven by Noise, whatever carrier or certificate is in between. While it waits for `e2ee_ready`,
the agent sends its `e2ee_hello` again every second (as `secure-channel.ts` does), for 10 s. A
ready that does not authenticate as the pinned key is `controller key mismatch`.

**Backoff.** After a loss, or a round in which nothing signed in, the next round of direct carriers waits a delay drawn
uniformly from 0 to a ceiling of 1 s, doubled at each failure up to 60 s (full jitter: 1, 2, 4, 8,
16, 32, then 60 s). A session that stayed signed in for 30 s starts the ceiling at 1 s again. A controller that
closes a direct carrier `1013` after a text frame `{"type":"retry","retry_after_ms":<n>}` (its sign-in queue was
full) is `controller busy`, and the next round waits at least `n` ms (at most a minute); the hint travels outside the
channel, so it can only make the machine wait. The relay is not dialed with the rounds: only at the machine's
instants ("The relay pace" below). The relay closing the socket `1013` (a room limit, or no PC answered in time) is
`relay busy` and waits for the next instant: the paced lane's answer is to come back later, not sooner.

**First dial of a fresh machine.** A machine whose fleet.json still holds its invite (it has not
enrolled yet) waits before its first round for a delay drawn uniformly from 0 to 10 s
(`FIRST_DIAL_SPREAD_MS`). Machines started at the same instant (a cloud batch) then reach the
controller spread over 10 s instead of together: the relay's waiting room holds 17, and 24 brand-new
machines started together waited up to 225 s for their first sign-in. Spread over 10 s, N machines
arrive about N/10 a second, so a hundred keep about ten in the waiting room at a time, while a
machine joining alone waits 5 s on average. A machine that enrolled before dials at once (its return
is the controller's to pace). `OVIS_LINK_FIRST_DIAL_SPREAD_MS` (0 to 60000) sets another window, 0
none.

**Keepalive.** Once signed in, a session that has heard nothing from the controller for 20 s sends
PING and ends `timeout` (SESSION_ERROR) when the PONG has not come 60 s later: the PC's rule for a
device session ([relay.md](relay.md), Limits, "Keepalive"), from the other end. The controller keeps the same rule on a
machine session (todo 37: `refreshIdle` in `shared/relay-mux-engine.ts` arms for any signed-in principal), so a dead
machine is noticed within 80 s at most, and the round trip of its PONG is PACE's `rtt_ms`. The two rules cannot flap:
each end's PING is traffic for the other, which only moves the other's 20 s further, and a PONG is answered at once.
The controller has one probe out at a time: the idle PING, the round trip PACE measures and the proof it asks for at
the end of a switch window (section 5) all share it, so a machine silent for 20 s gets one PING, and a half-open old
session that cannot answer it is ended `timeout`, never quarantined.

**Planned switch.** While the relay carries the session, the direct carriers are dialed again 5
minutes after sign-in, and every 5 minutes while none answers. One that proves the controller opens
a second session; once it is signed in, the relay session sends GOAWAY `shutdown` and drains for 5
s. That is the only time two sessions exist, well inside the controller's 10 s switch window. A
pipe is never moved: new pipes open on the new session, and a pipe still open on the old one has
the 5 s drain to finish before it resets with that session.

<!-- contract:exit-codes -->
| Code | Commands | Meaning |
| --- | --- | --- |
| 0 | status, rejoin, join, runtime-advert, --version, selftest | done (`run` never ends by itself: a signal stops it) |
| 2 | any | usage; for `selftest machine`, its configuration or machine key refused |
| 3 | selftest | the Noise handshake failed |
| 4 | selftest | a carrier message was not a valid record |
| 5 | selftest machine | the session ended with SESSION_ERROR |
| 6 | run | fleet.json or the machine key refused (`status.json` names why), or the state folder unusable |
| 7 | run | another `ovis-link run` holds this state folder |
| 8 | status, rejoin | the state folder cannot be read |
| 11 | join | the invite cannot be read: a file or a line that breaks section 4 |
| 12 | join | the invite's `server_id` is not its key's, or the owner key did not sign that controller |
| 14 | join | the state folder or a file in it cannot be made or written (a full disk among them) |
| 15 | join | the state folder already belongs to another controller |

### Joining a machine: `ovis-link join` and `ovis-link runtime-advert` (todo 28)

`ovis-link join --state <dir> --invite <- | file>` makes `<dir>` (0700) a machine's: it reads the invite from stdin
(`-`: the single-line form of section 4, as the paste block sends it) or from a file (the invite, or a line), one
reader; the line itself as an argument is refused (exit 2), since `ps` shows arguments. It makes `<dir>/machine.key` (0600, from the OS's random
source) when there is none, and writes `fleet.json` (0600) with the invite's `controller`, its `owner` block as the
controller wrote it, the key's path and the invite's id and secret. It dials nothing, and prints one JSON line:
`{"result":"written"|"kept","machine_id","server_id","invite_id","slot","exp"}`, or `{"error","detail"}` with
the exit code above. A folder that already holds this controller's fleet.json is kept as it is (`kept`: the same key,
the same machine id); one of another controller is refused (`already enrolled`).

The runtime's `serve --root <dir>/core` piped into `ovis-link runtime-advert --state <dir> --runtime-version <v>` writes advert.json
from the runtime's ready line: `native` with the runtime's socket and owner bearer, a new `boot_id` per ready line,
`runtime_id` `ovis-runtime`, and `none` as the versions of the bridge server and the agent sidecar, which this slice does
not install. The ready line goes nowhere else (every other line of the runtime goes to stderr); when the runtime's
output ends, advert.json is written again with `runtime_down`. A machine whose bridge is `ovis-server remote` runs no
`runtime-advert`: that bridge writes advert.json itself, one writer either way.

### Many machines at once (todo 37)

Every machine AUTH and every ENROLL, on a direct carrier or a relay link, is verified through one queue
(`server/fleet/sign-in-queue.ts`), each signature check one turn in the order it came (an enrolling machine's ENROLL
and then its AUTH are two turns):
at most 16 signatures at a time, the others in the order their AUTH came, 32 waiting at most. A queued machine is never
dropped for a newer one: on a direct carrier it keeps its place against newer clients (the listener's places for clients
not signed in give way only among the others), and a newcomer that finds 32 waiting is answered at once. On a direct
carrier that answer is the text frame `{"type":"retry","retry_after_ms":<n>}` (one second per 16 waiting, at most 60 s)
and a close `1013`; on a relay link, where nothing outside the channel reaches the machine, SESSION_ERROR
`resource_exhausted` `controller_limit`. A machine whose carrier closes while it waits frees its place at once. 16
verifying and 32 waiting hold at most 48 of a direct listener's 64 places for clients not signed in, so 16 stay for
phones. Device sign-ins never pass through the queue. A verification is one P-256 signature check (about 0.15 ms of CPU
measured here), so a flood of bad signatures waits its turn like any other and costs what it costs to check.

### The relay pace (todo 37)

One dial schedule for the whole fleet on the relay path, read on the controller's clock, with no clock shared in
advance. Pure functions in `server/fleet/relay-pace.ts` and `crates/fleet-link/src/pace.rs`; vectors in pace.json.

- **Pace.** From the budget the relay names in `sync` (`per_address_per_minute`; 30 when it names none):
  `per_minute = floor(budget * 4 / 5)` (at most 600), spacing `s = 60000 / per_minute` ms, the controller's burst
  `budget - per_minute - 2`. Hosted (30 a minute per address): 24, 2.5 s, 4. The Bun relay with the fleet flags (120):
  96, 625 ms, 22. The machines dial at the controller's `per_minute` on every budget but the hosted one, where they dial
  at 22 a minute (spacing 60000 / 22 ms; the owner's decision, todo 37): two below the controller's 24, so its bucket
  has a token left over for a stale machine's dial or a late device and never takes one a machine on its instant needs.
  PACE's `per_minute` is the machines'.
- **Slots.** Every machine that is not revoked has a `pace_slot` in the store from the write that made it (an ENROLL:
  a pending machine signs in and holds a session, so it dials the relay and hears PACE like an active one), the lowest
  number below `OVIS_FLEET_MAX` no record holds; a batch's confirmation keeps it, and so does a quarantine. It is kept
  until its record is removed; a machine re-enrolled into the invite slot of a revoked one takes that one's
  `pace_slot`. `span = max(OVIS_FLEET_MAX, per_minute)`. A slot a machine may still dial on is given out again only when no
  never-used slot is left: one freed by removing a machine that was offline (it never heard `auth_revoked`;
  `retired_pace_slots` in `machines.json`), and one a revoked record holds (it keeps it, for a re-enrolment into its
  invite slot, until it is given to another machine). So every machine that is not revoked holds a slot of its own
  while the fleet is within `OVIS_FLEET_MAX`, however many were revoked.
- **PACE.** AUTH_OK's `relay_pace` and PACE carry `{generation, per_minute, burst, slot, span, controller_ms, rtt_ms}`.
  AUTH_OK's `relay_pace` goes to every agent; PACE frames only to one whose AUTH named `pace` in `features` (an agent
  older than todo 37 refuses the frame as `protocol_error`, so it keeps its session on AUTH_OK's pace alone). The
  controller sends PACE to a machine after its sign-in (a pending one too: its AUTH_OK carries `relay_pace` beside
  `pending`, the PACE follows it, and after the confirmation's GOAWAY it signs in again on the same slot), whenever
  a field changes for it (a relay that names another budget raises `generation`; the store giving it its slot), and
  every 10 minutes. The agent keeps `offset =
  controller_ms - its monotonic clock at receipt` with error bound `rtt_ms`, and saves the fields in fleet.json.
  Before any PACE it uses 24 a minute, span 100 and the slot `machine id's first four hex digits mod 100`.
- **Dialing.** After a loss, the agent dials the relay only at the instants `(slot + k * span) * s` of the controller's
  timeline that come after the loss (one dial a cycle of `span * s` at most), gives each 5 s for the controller to
  answer, and keeps dialing its direct carriers with the backoff meanwhile. One exception: the GOAWAY that ends a pending
  session because the owner confirmed the machine (reason `confirmed`) is followed by one relay dial at once, so a
  confirmed machine is back in seconds; one per confirmation (given again only after a session that is not pending). A
  controller's shutdown GOAWAY (a restart) carries no reason: after it every machine, pending or not, keeps to its
  instants, and it does not use up the confirmed dial. A PACE whose cycle is under a minute
  (`span` below `per_minute`) is refused (`protocol_error`; one saved in fleet.json is left out), and whatever the
  pace, the agent waits at most an hour for its next relay dial (a PACE in range can make a cycle of days).
- **A new machine.** A machine that never held a PACE (fleet.json has no `relay_pace`) dials the relay once at once,
  where the relay would first be dialed (after its direct carriers' 1.5 s), so a join shows up in seconds. It records
  that dial in `<dir>/first-relay-dial` (wall ms); a restart within one fallback cycle (250 s) finds the mark and
  waits for its fallback instant. A fresh agent in a crash loop therefore dials the relay at most twice in any 250 s
  (the one unpaced dial and its grid instant), before the unit's start limit (todo 28) stops it. A fleet that restarts
  together holds saved paces and is not fresh: it stays on the grid. An instant missed by more than 1 s (a frozen
  process, a sleep) is not dialed late: the next one is, so a machine that wakes rejoins the timeline without a burst. A
  machine is stale when its error bound passes 1 s, it holds no PACE of this run (a restart), or its wall clock moved
  more than 1 s apart from its monotonic one (a suspend); a stale machine still dials once a cycle on its best guess.
- **Refusals.** A relay that answers 429 (its per-address budget) is tried once more after a uniformly random 1 to 5 s;
  a second refusal waits for the next instant. A refusal never shortens the cycle and never lengthens it either.
- **The controller's sockets.** While the fleet is in use, every socket the controller opens to its relay (control,
  warm, each data socket, a device's included) draws from one token bucket of `burst` (at least 2) that refills
  `per_minute` a minute, full when the control socket is first proven (R). The relay names a machine's dial in the paced
  lane (`sync` `paced`, `connected` `lane`), so the controller schedules by lane before it opens anything: control
  and warm first; during W = max(31 s, 13 spacings) after each proof a device first; after it a machine first and a
  device only from a spare token (two on hand). A machine's id that finds no token within 5 s goes unanswered; its
  machine dials again at its next instant. A relay that names no lanes leaves every id in the default lane, answered
  in the order announced.
- **The bounds** (100 machines behind one address, R <= 10 s, error E <= 1 s, Z stale machines, 8 devices): the
  machines' address sees at most 23 + Z dials in any minute hosted (<= 28 for Z <= 5) and 98 + Z with the fleet flags
  (<= 120 for Z <= 22); the controller opens at most `burst + per_minute` sockets in any minute (28 and 118); all
  machines are back by R + W + span * s + s + E, with s the machines' spacing and W the controller's: 319 s hosted
  (measured: 282 to 296 s on seeds 1-50, so the storm asserts 300 s), 105.125 s with the fleet flags. `bun
  scripts/fleet-storm.ts` checks these on an injected clock with a seeded jitter (same seed, same report), and shows
  what fails without each part: `--no-spacing` (429s), `--pace 24` on the fleet flags (past 180 s),
  `--own-loss-clock` (machines on one instant) and `--no-lanes` (devices later).
- **One opener.** These numbers assume one controller opens the machines' relay sockets: its bucket (`burst`,
  `per_minute`), the devices' window, the sign-in queue and the slots it hands out are all its own, and the machines'
  address sees only its machines' dials. The owner decided that several PCs may open machines later; then the budget of
  each relay address must be shared among the openers and the pace, the burst and the bounds recomputed (not done here).
- **The hosted bound with stale machines (decided).** Were the machines to dial at the controller's own 24 a minute,
  its bucket would refill exactly one token per machine instant, so each stale dial or late device after R + W would
  take a token a machine that is not stale needs; that machine would find none within its 5 s and wait a cycle (seeds
  1 to 50: only 2 within 300 s, the others 390 to 508 s). The owner decided the hosted machine pace of 22 a minute
  (todo 37), which leaves the bucket a token a minute over: seeds 1 to 50 then give 282 to 296 s (median 288 s), all
  within 300 s, and `bun scripts/fleet-storm.ts ... --bound 300000` asserts it. The fleet flags stay within 180 s on all
  of them at the controller's own 96, their burst of 22 absorbing it.

### Direct carriers (todo 29)

A machine signs in on the controller's direct listener ([relay.md](relay.md), "Direct on the same
network") as a phone does, and on two more kinds of address. While the fleet is in use, that is
while the controller's store holds a machine that is not revoked or an invite that is unused and unexpired
(`fleetInUse` in [`server/fleet/direct.ts`](../server/fleet/direct.ts); an empty store, revoked machines and spent
invites only, or a store that was refused is not), the listener also listens on the controller's container and VM
bridge adapters (names starting `docker`, `br-`, `virbr`, `veth`, `podman`, `lxc`, `lxd`, `vmnet`,
`vboxnet`), at their RFC 1918 IPv4 addresses only, at most 64 (in the system's order), on the
phones' port. Never a
public, shared (100.64.0.0/10), documentation, link-local or IPv6 address, and never `0.0.0.0`.
The adapters are read again with the others every 30 s and when the store changes; one that
appears gets a listener, one that goes loses it, and carriers already open stay. A Docker
network's bridge with no container on it is down and not listed (the adapter list holds those that are up
and running); it is taken at the first refresh after a container joins it, within 30 s. A host firewall that
drops what containers send to the host (ufw's default `deny (incoming)` does) must let the port
in on those adapters, or the machine stays on the relay. An address that
cannot be bound is left out without touching the phones' listeners. An address is a phone carrier or a
bridge one, never both: when the default route moves onto a bridge-named adapter, its address joins
the phones' list (main's rule) and its bridge listener goes first, so the phones keep their port and
the address takes devices as any phone address does; when it leaves the phones' list it becomes a
bridge address again on the same port.

- **For machines only.** A device's AUTH, PAIR or PAIR_REQUEST on a bridge address is refused
  `auth_failed` (at that frame, not at HELLO, so the refusal is read before the carrier closes), so no
  device signs in anywhere it could not before; nothing pairs there either. A machine session (and
  its ENROLL) is taken on every direct carrier, with the same gate (an `Origin`
  refused before any upgrade), the same waiting places, deadlines and connection counts, and the
  same sign-in rules as on the relay (a key the store does not hold is `auth_failed` `unknown`). ENROLL's
  per-address budget (section 4) is kept by the source address of the carrier.
- **Named to the machine.** A machine's AUTH_OK `direct` names, at most 4: the home network's
  first carrier, the first bridge and the Tailscale one, then the others. A phone's AUTH_OK, `GET
  /api/relay` and `/api/health` name exactly what they named before; bridge addresses are never
  told to a device.
- **Other systems.** The names are Linux's (Docker, libvirt, Podman, LXC/LXD), VMware's `vmnet`
  and VirtualBox's `vboxnet` (Linux and macOS). On Windows, Hyper-V and WSL switches are named
  `vEthernet (...)` and count as bridges (`veth`); VirtualBox there is "VirtualBox Host-Only
  Network", which does not. macOS's `bridge100` (Virtualization.framework, UTM) does not count.

## 6. What the relay, an attacker and a stolen key can do

- **A relay that reads and alters traffic, or anyone on the network path**, sees connection ids,
  timing, sizes, the `server_id` in the URL and the `lane=paced` dial of todo 35. It cannot read or
  change a frame: every record is AEAD-protected under the Noise keys, and an altered, dropped or
  reordered record closes the channel. It cannot pass for the controller without the controller's
  static key, so it never sees a machine's signature, invite signature, bridge token or runtime
  bearer. It can delay, drop or refuse connections (denial of service) and count machines and
  their activity.
- **A stolen machine key** (from `fleet.json` on the machine) lets its holder sign in as that
  machine, and gives nothing a device has: it cannot open HTTP or WS streams, pair, mint, confirm
  or remove, and it opens no pipe. What it can do is answer the pipes the controller opens to that
  machine, so it can show the operator a false machine and read what the operator sends there.
  While the real machine is also connected, two sessions on one key at the end of the 10 s switch window are each asked
  a PING: if both answer within 5 s the machine is quarantined and both end (todo 30); a session that stays silent is
  ended `timeout` and the machine keeps the other one (section 5). Removal ends it: `DELETE /api/fleet/machines/<id>` (todo 31) closes the live session
  `auth_revoked`, refuses every later AUTH with that key, and writes the key's fingerprint into the
  controller's witness, so not even a restored state folder lets it back in.
- **The controller's pinned key** protects every machine from talking to anyone else: the NK
  handshake fails against any other key, so a machine's tokens, bearer, AUTH signature and ENROLL
  signature reach only the holder of that key, and each signature is bound to its own channel. A
  stolen controller key is full authority over the fleet (it can receive the machines' dials and
  their adverts); the channel binding only keeps the signatures it collects from working against
  the real controller. Recovery is a new controller key and new invites for every slot
  (`--slots-from`, todo 31).
- **The owner key's secret half** is `<state>/fleet/owner.json` on the controller PC (made by `ovis-server fleet
  owner`, with its recovery phrase shown once). So today a stolen controller PC yields the controller key AND the owner
  seed. With one member that is no more than the controller key already gives; once a member list exists, the owner
  seed alone is full authority over the fleet (it signs members), and recovery from its theft is re-enrolling every
  machine. Moving the seed off the PC (kept only as the recovery phrase, or in a vault) is later work.
- **A silent second session** (todo 31): when the PING at the end of a switch window ends one session of a key while
  the other answered (a copy of the key whose holder never answers, or an attacker on the real machine's path who also
  holds a copy and delays the real session's PONG), the controller raises an alert (`fleet.alert` `silent_session`,
  with a count); the 6th such event within 24 h (`SILENT_QUARANTINE`) quarantines the key (`silent_sessions`), so neither case repeats for
  ever, and the operator releases and re-enrols the slot. While two sessions of one key are signed in, no new pipe
  opens on either: a connection waits until one of them is proven the only one. Each machine's row in `GET
  /api/fleet/machines` carries `alerts: {count, last}` since the controller started, and `ovis fleet list` an ALERTS
  column; the Fleet screen's alerts are todo 33's. An honest machine whose old session went half-open (a network change,
  a sleep) looks the same as a silent copy, hence a threshold of 6 rather than 3 until todo 37's keepalive.

## Limits

<!-- contract:limits -->
| Limit | Value | Exceeded by | Answer |
| --- | --- | --- | --- |
| `max_pipe_streams` | 16 | a 17th pipe open at once | RESET `refused` |
| `pipe_window_bytes` | 786432 | PIPE_DATA beyond the credit granted | SESSION_ERROR `flow_control_error` |
| `pipe_data_bytes` | 16376 | a larger PIPE_DATA payload (frame above `max_frame_bytes` 16384) | SESSION_ERROR `protocol_error` |
| `metadata_frame_bytes` | 1024 | a larger AUTH, AUTH_OK, ENROLL, ENROLL_OK, PIPE_OPEN, PACE, FLEET_STATE or RESET frame | SESSION_ERROR `protocol_error` |
| `pipe_advert_bytes` | 4096 | a larger PIPE_ADVERT | SESSION_ERROR `protocol_error` |
| `advert_endpoints` | 2 | more endpoints, a repeated one or an unknown one | SESSION_ERROR `protocol_error` |
| `native_bearer_bytes` | 512 | a longer `native_bearer` | SESSION_ERROR `protocol_error` |
| `enroll_tries_per_invite` | 5 | a sixth refused ENROLL for one invite (a valid one is still taken) | SESSION_ERROR `auth_failed` |

These agree with LIMITS_V1 (`shared/relay-mux.ts`): `max_frame_bytes` 16384 is unchanged, and
`max_pipe_streams` windows of `pipe_window_bytes` add up to the engine's 12 MiB receive reservation
(`MUX_RECEIVE_RESERVATION_BYTES`; `scripts/fleet-contract-check.ts` checks both); `max_streams`, `max_ws_streams` and
`max_sse_streams` keep their values in WELCOME but admit nothing on a machine session. 4096 for
PIPE_ADVERT and 512 for the bearer are decided in todo 9 (the advert's fixed fields need under 1
KiB; the runtime's bearer format is the runtime's own, and 512 bytes bounds it). The five ENROLL tries are
todo 30's. Timing rules that are not frame limits belong to their todos: the 10 s switch window
(30), the 15 s sign-in deadline (as today, [relay.md](relay.md)), the sign-in queue and pace (37).

## Fields

<!-- contract:fields -->
| Frame | Field | Encoding | Required | Rule |
| --- | --- | --- | --- | --- |
| `HELLO` | `protocol` | string | yes | `"ovis-mux"` |
| `HELLO` | `versions` | array of integers | yes | contains 1 |
| `HELLO` | `features` | array of strings | yes | contains `pipe-stream`, no device feature |
| `HELLO` | `required_features` | array of strings | yes | contains `pipe-stream` |
| `WELCOME` | `protocol` | string | yes | as today |
| `WELCOME` | `version` | integer | yes | as today |
| `WELCOME` | `features` | array of strings | yes | as today |
| `WELCOME` | `limits.max_streams` | integer | yes | as today |
| `WELCOME` | `limits.max_ws_streams` | integer | yes | as today |
| `WELCOME` | `limits.max_sse_streams` | integer | yes | as today |
| `WELCOME` | `limits.max_frame_bytes` | integer | yes | 16384 |
| `WELCOME` | `limits.http_window_bytes` | integer | yes | as today |
| `WELCOME` | `limits.ws_window_bytes` | integer | yes | 1048576 |
| `WELCOME` | `limits.max_ws_message_bytes` | integer | yes | as today |
| `WELCOME` | `limits.max_request_body_bytes` | integer | yes | as today |
| `WELCOME` | `limits.max_pipe_streams` | integer | yes | 1..16; 16 from a controller |
| `WELCOME` | `nonce` | base64url, 32 bytes | yes | new per session; signed raw in AUTH |
| `WELCOME` | `server_version` | string | yes | as today |
| `WELCOME` | `relay_protocol` | integer | yes | as today |
| `WELCOME` | `min_supported_client` | string | yes | as today |
| `AUTH` | `scheme` | string | yes | `"machine-key"` |
| `AUTH` | `machine_id` | hex, 32 digits | yes | fingerprint of the machine key |
| `AUTH` | `signature` | base64url, 64 bytes | yes | ECDSA P-256 `r \|\| s` over the 113 bytes of section 1 |
| `AUTH` | `features` | array of strings | no | up to 16 distinct names of 1-32 bytes `a-z0-9_-`: what this agent reads beyond every agent's frames; `pace`: PACE frames (todo 37; todo 31 adds `fleet_state`). Unknown names are ignored, absent means none; not signed (the channel carries it) |
| `AUTH` | `seen_state.generation` | integer | no | as received in FLEET_STATE |
| `AUTH` | `seen_state.tag` | base64url, 32 bytes | no | as received in FLEET_STATE |
| `AUTH_OK` | `session_id` | hex, 32 digits | yes | as today |
| `AUTH_OK` | `machine_id` | hex, 32 digits | yes | the AUTH's `machine_id` |
| `AUTH_OK` | `role` | string | yes | `"machine"` |
| `AUTH_OK` | `relay_pace.generation` | integer | no | as PACE |
| `AUTH_OK` | `relay_pace.per_minute` | integer | no | as PACE |
| `AUTH_OK` | `relay_pace.burst` | integer | no | as PACE |
| `AUTH_OK` | `relay_pace.slot` | integer | no | as PACE |
| `AUTH_OK` | `relay_pace.span` | integer | no | as PACE |
| `AUTH_OK` | `relay_pace.controller_ms` | integer | no | as PACE |
| `AUTH_OK` | `relay_pace.rtt_ms` | integer | no | as PACE |
| `AUTH_OK` | `direct` | array of strings | no | 1..4 distinct `ws://<IPv4>:<port>`, each a private (RFC 1918, link-local) or Tailscale address: no name, no loopback |
| `AUTH_OK` | `pending` | boolean | no | `true` only: the machine waits for its batch to be confirmed; absent otherwise |
| `SESSION_ERROR` | `code` | string | yes | a session error code of `shared/relay-mux.ts` |
| `SESSION_ERROR` | `message` | string | yes | at most 256 bytes; on a refused sign-in or enrolment, one of the causes of section 1 |
| `PING` | `probe` | u64 big-endian, the whole payload (vectors: decimal string) | yes | any |
| `PONG` | `probe` | u64 big-endian, the whole payload (vectors: decimal string) | yes | the PING's |
| `RECEIVED` | `frames` | u64 big-endian, the whole payload (vectors: decimal string) | yes | frames received so far, RECEIVED not counted; at most the frames the receiver sent |
| `GOAWAY` | `code` | string | yes | `shutdown` or `id_exhausted` |
| `GOAWAY` | `last_open_id` | integer | yes | 0 or an even pipe id |
| `GOAWAY` | `drain_ms` | integer | yes | 0..5000 |
| `GOAWAY` | `reason` | string | no | 1-32 bytes `a-z0-9_-`; `confirmed` only on the GOAWAY that ends a pending machine's session once the owner confirmed it (todo 37): the machine then dials the relay at once. A shutdown sends none; a reason a reader does not act on is ignored |
| `CREDIT` | `consumed` | u64 big-endian, the whole payload (vectors: decimal string) | yes | at most the bytes sent on that pipe |
| `RESET` | `code` | string | yes | one of the pipe reset codes |
| `RESET` | `message` | string | yes | at most 256 bytes |
| `PIPE_OPEN` | `endpoint` | string | yes | 1..32 of `[a-z0-9-]`; `bridge` or `native` to be accepted |
| `PIPE_DATA` | `data` | raw bytes, the whole payload (vectors: hex) | yes | 1..16376 bytes |
| `PIPE_ADVERT` | `endpoints` | array of strings | yes | 1..2 distinct of `bridge`, `native` |
| `PIPE_ADVERT` | `runtime_id` | string | yes | 1..64 of `[A-Za-z0-9._:-]` |
| `PIPE_ADVERT` | `boot_id` | string | yes | 1..64 of `[A-Za-z0-9._:-]`, new at each runtime start |
| `PIPE_ADVERT` | `bridge_token` | hex, 64 digits | if bridge | the bridge's token (`server/bridge.ts:82`) |
| `PIPE_ADVERT` | `native_bearer` | string | if native | 1..512 bytes of `0x21`..`0x7e` |
| `PIPE_ADVERT` | `health.runtime` | string | yes | `up` or `down` |
| `PIPE_ADVERT` | `health.bridge` | string | yes | `up` or `down` |
| `PIPE_ADVERT` | `now` | integer | yes | machine clock, seconds; advisory |
| `PIPE_ADVERT` | `versions.server` | string | yes | 1..64 of `[0-9A-Za-z.+-]` |
| `PIPE_ADVERT` | `versions.link` | string | yes | 1..64 of `[0-9A-Za-z.+-]` |
| `PIPE_ADVERT` | `versions.agent` | string | yes | 1..64 of `[0-9A-Za-z.+-]` |
| `PIPE_ADVERT` | `versions.runtime` | string | yes | 1..64 of `[0-9A-Za-z.+-]` |
| `ENROLL` | `invite_id` | hex, 16 digits | yes | the invite's `id` |
| `ENROLL` | `machine_public_key` | base64url, 91 bytes | yes | P-256 SPKI DER |
| `ENROLL` | `signature` | base64url, 64 bytes | yes | Ed25519 over the bytes of section 4 |
| `ENROLL` | `now` | integer | yes | machine clock, seconds; advisory |
| `ENROLL_OK` | `machine_id` | hex, 32 digits | yes | fingerprint of `machine_public_key` |
| `PACE` | `generation` | integer | yes | rises when the pace changes (todo 37) |
| `PACE` | `per_minute` | integer | yes | 1..600 |
| `PACE` | `burst` | integer | yes | 0..600 |
| `PACE` | `slot` | integer | yes | 0..span-1 |
| `PACE` | `span` | integer | yes | 1..4096, and at least `per_minute` (a cycle of a minute at least; refused otherwise) |
| `PACE` | `controller_ms` | integer | yes | controller wall clock when sent, ms |
| `PACE` | `rtt_ms` | integer | yes | 0..60000, the latest keepalive round trip |
| `FLEET_STATE` | `generation` | integer | yes | the controller's witness generation |
| `FLEET_STATE` | `tag` | base64url, 32 bytes | yes | HMAC of section 1 |
| `INVITE` | `v` | integer | yes | 1 |
| `INVITE` | `id` | hex, 16 digits | yes | |
| `INVITE` | `slot` | integer | yes | 0..65535 |
| `INVITE` | `controller.server_id` | hex, 32 digits | yes | derived from `server_public_key` |
| `INVITE` | `controller.server_public_key` | base64, 32 bytes | yes | the controller's Noise static key |
| `INVITE` | `controller.relay` | string or null | yes | a `wss:` origin |
| `INVITE` | `controller.direct` | array of strings | yes | 0..4 `ws://<host>:<port>` |
| `INVITE` | `secret` | base64url, 32 bytes | yes | 32 random bytes |
| `INVITE` | `exp` | integer | yes | seconds; judged by the controller only |
| `INVITE` | `owner.public_key` | base64url, 32 bytes | yes | the fleet's owner key (Ed25519): what the machine pins |
| `INVITE` | `owner.member.v` | integer | yes | 1 |
| `INVITE` | `owner.member.server_id` | hex, 32 digits | yes | derived from `owner.member.server_public_key` |
| `INVITE` | `owner.member.server_public_key` | base64, 32 bytes | yes | the controller's static key: equal to `controller.server_public_key`, else `controller_not_member` |
| `INVITE` | `owner.member.class` | string | yes | `opener` (the controller) or `worker`; a later version adds `answer_only` |
| `INVITE` | `owner.member.open` | boolean | yes | may open pipes to others: `true` for the pinned controller, else `controller_not_member` |
| `INVITE` | `owner.member.write` | boolean | yes | may change the member list (read by a later todo) |
| `INVITE` | `owner.signature` | base64url, 64 bytes | yes | Ed25519 by the owner key over `"ovis-fleet-member/1"` and the member's canonical JSON, else `controller_not_member` |
| `INVITE_LINE` | `file_hex` | hex | yes | the invite file's bytes the line decodes to, then read as `INVITE` |
| `FLEET_FILE` | `v` | integer | yes | 1 |
| `FLEET_FILE` | `controller.server_id` | hex, 32 digits | yes | derived from `server_public_key`, else `controller key mismatch` |
| `FLEET_FILE` | `controller.server_public_key` | base64, 32 bytes | yes | the controller's Noise static key: the only key the agent finishes a handshake with |
| `FLEET_FILE` | `controller.relay` | string or null | yes | a `wss:` origin, or `ws://<loopback IPv4>:<port>` for a relay on the machine itself |
| `FLEET_FILE` | `controller.direct` | array of strings | yes | 0..4 distinct `ws://<host>:<port>`: a private, Tailscale or loopback IPv4 address, or a name dialed only at such addresses |
| `FLEET_FILE` | `machine_key_file` | string | yes | absolute path of the machine key (32 raw bytes, mode 0600) |
| `FLEET_FILE` | `invite.id` | hex, 16 digits | no | the invite's `id`: while `invite` is present the agent sends ENROLL before its first AUTH (section 4) |
| `FLEET_FILE` | `invite.secret` | base64url, 32 bytes | no | the invite's `secret`; the agent removes `invite` once ENROLL_OK came |
| `FLEET_FILE` | `owner.public_key` | base64url, 32 bytes | yes | the fleet's owner key (Ed25519): what the machine pins |
| `FLEET_FILE` | `owner.member.v` | integer | yes | 1 |
| `FLEET_FILE` | `owner.member.server_id` | hex, 32 digits | yes | derived from `owner.member.server_public_key` |
| `FLEET_FILE` | `owner.member.server_public_key` | base64, 32 bytes | yes | the controller's static key: equal to `controller.server_public_key`, else `controller_not_member` |
| `FLEET_FILE` | `owner.member.class` | string | yes | `opener` (the controller) or `worker`; a later version adds `answer_only` |
| `FLEET_FILE` | `owner.member.open` | boolean | yes | may open pipes to others: `true` for the pinned controller, else `controller_not_member` |
| `FLEET_FILE` | `owner.member.write` | boolean | yes | may change the member list (read by a later todo) |
| `FLEET_FILE` | `owner.signature` | base64url, 64 bytes | yes | Ed25519 by the owner key over `"ovis-fleet-member/1"` and the member's canonical JSON, else `controller_not_member` |
| `FLEET_FILE` | `relay_pace.generation` | integer | no | as PACE; the agent writes `relay_pace` back from its controller's newest PACE (todo 37) |
| `FLEET_FILE` | `relay_pace.per_minute` | integer | no | as PACE |
| `FLEET_FILE` | `relay_pace.burst` | integer | no | as PACE |
| `FLEET_FILE` | `relay_pace.slot` | integer | no | as PACE |
| `FLEET_FILE` | `relay_pace.span` | integer | no | as PACE |
| `FLEET_FILE` | `relay_pace.controller_ms` | integer | no | as PACE; its offset is not kept: a restarted agent is stale until the next PACE |
| `FLEET_FILE` | `relay_pace.rtt_ms` | integer | no | as PACE; a `relay_pace` that breaks a rule is left out, never a reason to refuse the file |
| `ADVERT_FILE` | `v` | integer | yes | 1 |
| `ADVERT_FILE` | `runtime_id` | string | yes | as PIPE_ADVERT |
| `ADVERT_FILE` | `boot_id` | string | yes | as PIPE_ADVERT |
| `ADVERT_FILE` | `bridge_port` | integer | with `bridge_token` | 1..65535, on 127.0.0.1 |
| `ADVERT_FILE` | `bridge_token` | hex, 64 digits | with `bridge_port` | as PIPE_ADVERT |
| `ADVERT_FILE` | `native_bearer` | string | no | as PIPE_ADVERT; offers `native` |
| `ADVERT_FILE` | `native_socket` | string | no | absolute path; else where the runtime resolves its socket |
| `ADVERT_FILE` | `runtime_down` | boolean | no | `true` makes `health.runtime` `down` |
| `ADVERT_FILE` | `versions.server` | string | yes | as PIPE_ADVERT |
| `ADVERT_FILE` | `versions.agent` | string | yes | as PIPE_ADVERT |
| `ADVERT_FILE` | `versions.runtime` | string | yes | as PIPE_ADVERT (`versions.link` is the agent's own) |

PIPE_ACCEPT and PIPE_END have an empty payload. PACE's ranges (decided in todo 9) leave room above
both profiles of todo 37 (machines at 22 and 96 a minute, span 100); `rtt_ms` ends at the 60 s PONG deadline
(`shared/relay-mux-engine.ts:1262`).

## Vector files

`server/fleet/vectors/` holds `auth.json`, `pipe-frames.json`, `enroll.json`, `invite.json`,
`machine-files.json`, `pace.json` and `records.json`, written by `bun scripts/fleet-vectors.ts` from fixed inputs; `--check` regenerates them
and fails when a file differs. Every key, secret, nonce and token in them is a fixed test value
(the generator derives each from a label) and must never be used outside tests. Each file is a JSON
object with `file`, `test_only`, `derivations` (inputs and outputs of the formulas above) and
`cases`. Each case has:

- `name` (unique across the files), `frame` (a name of the frames table, a frame of section 3, or
  `INVITE`), `type` (the envelope type as an integer; `null` for the invite file), `stream_id`,
  `direction` (`machine_to_controller`, `controller_to_machine` or `file`) and `context` (the
  session state and every fact the receiver needs: `state` is `before_auth` or `after_auth`,
  `selected` the features in force, and nonces, bindings, keys or store facts as hex or base64url);
- `bytes`: the exact frame (or file) in hex;
- `expect`: `parse` (the payload as JSON, with the raw payloads named in the field table) and/or
  `refuse` `{stage, kind, code, message?}`. `stage` is `decode` (the codec refuses the bytes; no
  `parse`), `verify` (parsed, a signature or tag check refuses) or `session` (parsed, the session's
  state or direction refuses). `kind` is `session_error`, `reset`, `invalid_invite` or `invalid_file` (machine-files.json:
  `invalid_fleet`, `controller_key_mismatch`, `controller_not_member` or `invalid_advert`). An accepted
  case may add `effect`, what the receiver does beyond parsing;
- `limit` (optional): the limit of the limits table this case exceeds;
- `canonical: false` on an accepted case whose bytes are not the canonical encoding.

**records.json** is of another kind: the channel every frame above travels in (section 1), as the
TypeScript code of `shared/vendor/paseo-e2ee` (Noise and `protected-records.ts`) produces it, so the
Rust link agent (todo 22) can match it byte for byte. Its `derivations` fix a handshake (keys,
prologue `paseo-relay-e2ee/1`, the parameter payload `0x01 0x01` that offers and selects binary
ciphertext, both messages, the handshake hash and the channel binding); `records` is the transcript
both ends then send, in order; each case has a `stage`: `handshake` (the initiator reads this
message 2), `record` (the initiator of a fresh run of that handshake receives these records in
this order, at most `max_carrier_binary_bytes` each, the limit of `shared/relay-e2ee.ts`), and
`encode` or `decode` (one record through a cipher state at a given key and counter). A refusal names
the `error` the TypeScript code gives; any failure ends the channel, so nothing after it is read.
The JSON envelopes that carry the two handshake messages (`e2ee_hello`, `e2ee_ready`) and the
choice of a binary or base64 carrier message are built by todo 23, as `shared/vendor/paseo-e2ee`
builds them; the dial that sends them (and repeats the hello) is todo 24's. The refusals every
implementation must make:

<!-- contract:records -->
| Case | Stage | Error |
| --- | --- | --- |
| `records/handshake/message-2-flipped-ciphertext-byte` | handshake | authentication failed |
| `records/handshake/message-2-flipped-ephemeral-byte` | handshake | authentication failed |
| `records/handshake/wrong-responder-key` | handshake | authentication failed |
| `records/handshake/message-2-truncated` | handshake | handshake message truncated |
| `records/record/truncated` | record | record truncated |
| `records/record/replayed` | record | authentication failed |
| `records/record/out-of-order` | record | authentication failed |
| `records/record/over-carrier-limit` | record | Carrier message too large |
| `records/nonce/encrypt-at-maximum` | encode | nonce exhausted |
| `records/nonce/decrypt-at-maximum` | decode | nonce exhausted |

`server/fleet/vectors-shape.test.ts` checks the shape of every case and reproduces enroll.json's
invite key and signatures with WebCrypto. `bun scripts/fleet-contract-check.ts` parses the tables
of this document and fails, naming what is missing, unless every frame has an accepted case of its
type in its file, every field appears in an accepted case of its frame (and every field of an
accepted case is in the table), every limit has a case refused with its answer, every row of
section 3 has a case refused with its answer, every cause has a case with its code and message,
every pipe reset code has a RESET case, every row of the records table has its case refused with
its error, and records.json's transcript carries a binary and a text record each way; on success it
prints `CONTRACT COVERED`. The codec
tests that consume the files are written by the todos that build each codec: auth.json by todo 20
(its FLEET_STATE and `seen_state` cases by todo 31), pipe-frames.json by todo 21, enroll.json and
invite.json by todo 30, pace.json by todo 37, and the Rust side by todos 22, 23, 30, 31 and 37.

## Decisions made in todo 9

Each is marked where it is stated above. A reviewer who disagrees changes this document, the
generator and the vectors together.

1. Types `0x40`-`0x48`; `0x40`-`0x43` stream frames, `0x44`-`0x48` session frames; `0x49`-`0x4f` free.
2. Pipe ids consecutive (2, 4, 6, ...), as client opens are.
3. CREDIT, RESET and GOAWAY take even ids only with `pipe-stream` selected.
4. Signed bytes: ASCII domains `ovis-fleet-auth/1` and `ovis-fleet-enroll/1`; ids as their ASCII
   hex text; keys, nonces and bindings raw.
5. `machine_id` is the key's fingerprint (first 16 bytes of SHA-256 over the SPKI DER, hex).
6. AUTH_OK for a machine names `machine_id`, not `device_id`.
7. The FLEET_STATE tag's input is `server_id` (32 ASCII bytes) and `generation` as 8 bytes big-endian.
8. The invite id enters the HKDF info as its 16 ASCII hex characters.
9. Refusal causes travel in SESSION_ERROR's `message`, from a fixed list.
10. A HELLO with `pipe-stream` and a device feature is `protocol_error`; PAIR, PAIR_REQUEST and AUTH
    `device-key` after such a HELLO are `auth_failed` `wrong_scheme`.
11. PIPE_ADVERT field formats (`runtime_id`, `boot_id`, `bridge_token`, `native_bearer`, `health`,
    `versions`), a 4096-byte frame limit and a 512-byte bearer limit.
12. PACE and FLEET_STATE ranges; `rtt_ms` at most 60000.
13. A RESET code other than the five on a pipe is `protocol_error`; a failed connect is
    `upstream_lost`.
14. The controller forgets a machine's advert when its session ends.
15. GOAWAY `last_open_id` on a machine session is a pipe id; the controller ends the id space with
    `id_exhausted`.
16. Canonical encoding: compact JSON in field-table order.
17. ENROLL_OK is `{machine_id}`, and AUTH follows on the same session.
18. Invite file: `slot` 0..65535, `relay` or `null`, `direct` with names, at most 4096 bytes;
    `invite_public_key` kept as 64 hex digits.
19. A second key on one invite is answered `auth_revoked` `quarantined`.

Decided after todo 9:

20. Pipe windows of 768 KiB (786432 bytes), so 16 pipes reserve the engine's 12 MiB (the owner, on
    2026-11-12).
21. A second AUTH or HELLO after AUTH_OK, and a type of `0x49`-`0x4f`, are `protocol_error` on a
    machine session (todo 20).
22. A HELLO that offers `pipe-stream` without requiring it is `protocol_error` on a controller with the
    fleet extension (todo 21).

## Left to later todos

How the Fleet screen words causes, alerts and the restore notice (todo 33); and what `versions` triggers (todo 59).
