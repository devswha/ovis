# A fleet bridge on classic herdr

A machine can keep its existing herdr session and run `ovis-server remote` beside it for a fleet controller. Set `OVIS_FLEET_BRIDGE=1` and `OVIS_RUNTIME=herdr`. The service runs as the engine's owner, with that account's `HOME`, `SHELL` and `XDG_CONFIG_HOME` where used. Agent discovery includes the ordinary remote bridge's login-shell probe.

The join supplies `HERDR_REMOTE_SOCKET`, the canonical absolute socket path of the selected session. `HERDR_REMOTE_SESSION` can name a session under herdr's configuration root when no socket is supplied. With neither, exactly one running session is selected. None or several leave the bridge running with a reason, waiting for a usable selection. A malformed `HERDR_REMOTE_SOCKET` or `HERDR_REMOTE_SESSION` also leaves it running: `runtime_down` stays true, authenticated health reports `herdr_setting_invalid`, and one plain log line names the bad setting without echoing its value. Correct the service environment and restart the bridge to select the intended session. Once selected, the socket stays selected until the bridge stops. `HERDR_SOCKET` inherited from another pane is not a session selector for this entry.

The bridge never starts, stops, installs, updates or reconfigures herdr. `HERDR_REMOTE_START_NEW` does not change that. A missing engine is retried every two seconds without restarting the HTTP server. After a late first start, `herdr_connecting` keeps the advert down until the full status and lifecycle subscriptions are ready; connected pages then receive the first pane status change. The bridge never takes a pane's attach slot automatically or changes herdr's focus merely because a browser selected a pane.

`OVIS_FLEET_HOME` defaults to `~/.local/share/ovis-fleet`. Its `server/` holds the bridge's normal private state. `OVIS_FLEET_STATE` defaults to its `state/`; use the same folder for `ovis-link run --state`. Newly created directories are mode 0700. The bridge writes there:

- `advert.json`, mode 0600, replaced in one rename: version 1, `runtime_id`, `machine_id`, `boot_id`, `bridge_port`, `bridge_token`, `runtime_down`, and `versions`. Classic herdr offers no native endpoint, bearer or socket. `versions.runtime` is `herdr-<version>`.
- `bridge.json`, mode 0600: the bridge descriptor and process ownership. It is never registered in the ordinary remote bridge registry.
- `bridge.json.lock/` and permanent sibling guard files: one live bridge per canonical fleet state directory, including while its engine is down.
- `runtime-id.json`, mode 0600, always created on the first start: `{ v: 1, runtime_id, source }`. The source is `{ kind: "own-ovis", state_dir }` or `{ kind: "minted" }`. Every later start uses this record alone. Preserve it during upgrades.

The PC's own Ovis identity exists only once that Ovis has started its relay and saved `<state>/relay/identity.json`. On the bridge's first start, that saved relay server ID becomes `runtime_id`, read without changing the own Ovis state. Before the relay has ever started, the bridge mints a UUID even if the own Ovis is running. The join must use the own Ovis's `OVIS_STATE_DIR` when it is non-default, and preserve its `XDG_CONFIG_HOME`; otherwise it may look in a different state folder. The controller merges the fleet record into an existing relay or SSH row carrying that ID, and currently serves that row only through its existing route. Route selection for a merged row belongs to later work; its fleet bridge is not used today. A separate SSH bridge with no known PC identity cannot be claimed as the same PC. The fallback UUID is independent of engine and bridge lifetimes. An own Ovis identity that appears after the first start is logged once per bridge process, including when it appears during a recheck, and does not replace a minted id. Enabling the own Ovis relay after the join can therefore produce a separate relay row; reconciling that case belongs to later work. A join that wants the existing relay identity must make it visible before the bridge first starts, and must preserve `runtime-id.json` afterward. An own Ovis identity selected first remains the same even if a later bare service environment cannot find its original state folder. `boot_id` is the existing herdr lifetime digest of the socket's device, inode and birth timestamp, so replacing the engine changes it. Before the engine answers it is `awaiting-herdr`.

The HTTP listener is always `127.0.0.1` on an ephemeral port. `HOST`, `PORT` and `OVIS_TOKEN` do not select its listener or credential. Each bridge process generates a random token. The link reads that token from the private advert. The bridge has no controller identity and starts no relay link or direct listener of its own.

Authenticated `GET /api/health?scope=bridge` remains available while herdr is down. Its `fleet_bridge` object includes `engine`, `socket_path`, `runtime_id`, `boot_id`, `runtime_down`, `reason`, `message`, and `terminal_mode` (`attach` or `mirror`). These facts are not returned to an anonymous caller. When herdr answers, `GET /api/bridge` identifies its actual socket; compare it with the join's selected socket. `GET /api/session` lists that engine's panes, including panes created before the bridge started.

## The terminal host beside a compiled server

The compiled server's root is the directory containing `ovis-server`. Put the Rust host at `bin/ovis-pty-sidecar` under that root, executable, and its record at `bin/ovis-pty-sidecar.json`. The record must contain the binary's SHA-256 as `sha256` and the compiled server's package version as `version`. The server checks both and probes the host before using it.

For an installer placing the server at `$OVIS_FLEET_HOME/bin/ovis-server`, that means the host goes at `$OVIS_FLEET_HOME/bin/bin/ovis-pty-sidecar`, with its `.json` record beside it. Do not use `OVIS_PTY_SIDECAR_BIN` to bypass the installed-file check.

The Node fallback needs real Node 18 or newer of the server's architecture, `pty-host.mjs` beside the compiled server, and `node_modules/@lydell/node-pty` with its platform package. The Rust host requires neither Node nor Bun installed separately. Without a working host the bridge mirrors panes. Check `/api/health` for `herdr.terminal_attach: true`; a running HTTP listener alone does not prove live attachment.

## Sharing a session with the machine's own Ovis

herdr grants one attach slot per pane. Both servers keep listing and serving, but only the holder streams that pane's terminal. The second viewer sees: "Another web bridge has this pane open. It connects here as soon as that bridge lets go." The page's typing and sends are refused as `attach_held`; it retries attachment automatically every three seconds after the first server lets go. Chat transcripts, status and prompt cards use their existing read paths independently of that attach slot. Explicit take-over remains a separate user action. Authenticated HTTP `POST /api/pane/input` and `POST /api/pane/keys` on the server that is held refuse the same way: they send nothing and answer `409` with `attach_held` and the same message, while reads keep working; they type again once the other server lets go. A server only knows a pane is held while one of its own clients has that pane open. This also applies to the local pane routes of `OVIS_PROFILE=machine`. That profile refuses `/api/machines/...` with `409 machine_profile`; it does not forward those requests. Two starts of that profile with the same state directory cannot run together: its state lease refuses the second start. Ordinary servers on separate ports may still share a state directory.

The compiled-container QA script is `scripts/fleet-product-qa.ts`. It uses a real herdr, two compiled Ovis servers, an authenticated controller fleet forward, and a Claude-shaped process with real local transcript and menu files. No paid agent or live user's session is used.


## A fleet bridge on herdr-core

Set `OVIS_FLEET_BRIDGE=1` and `OVIS_RUNTIME=herdr-core`. The same private listener, descriptor,
lasting PC identity, advert writer and recheck clock serve this engine. No native endpoint or
credential is included in its advert. `versions.runtime` is `herdr-core-<version>`.

The join supplies `HC_SESSION=<existing session>` and `HC_SOCKET=<absolute native socket>`, and
`OVIS_HC_BIN=<absolute existing hc executable>`. Session names accept ASCII letters, digits, dot,
underscore and hyphen, up to 64 characters, excluding `.` and `..`. Keep the engine account's
`HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`, plus `SHELL` and `PATH`.
The bridge neither installs nor updates hc. Without `OVIS_HC_BIN`, ordinary hc discovery checks
trusted install directories, PATH and the login PATH using `--version` only.

Without `HC_SOCKET`, the native path follows hc: `socket` in
`$XDG_CONFIG_HOME/herdr-core/config.toml` (config defaults to `$HOME/.config`), otherwise
`$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, then `/run/user/<uid>/herdr-core/<session>.sock`
when that runtime directory exists, otherwise
`$XDG_STATE_HOME/herdr-core/<session>/<session>.sock` (state defaults to `$HOME/.local/state`).
With neither selector, the bridge probes account-local candidates and selects exactly one
answering core. None or several leave it alive with `runtime_down` and a reason. Selection stays
pinned for that bridge process, including while the core is stopped. Background services also
stay disconnected until selection; they never silently use a default core among several.

Malformed `HC_SESSION` or `HC_SOCKET` settings, including control characters in a socket path,
leave the bridge up with `hc_setting_invalid`. With neither selector, unreadable core session
directories leave it up with `hc_discovery_refused`; correct their permissions and the next
recheck can select an answering core.
Health and one log line name the setting without echoing its value; no other core is selected.
The socket is taken only when its whole path is the account's: walked from `/`, every folder and
link on the way belongs to the account or root and no folder is writable by another account (a
sticky folder such as `/tmp` only above the socket's own folder), and the socket itself is the
account's and is not a symbolic link (its mode, which hc takes from the umask, only says who may
connect to it; the folder holding it decides who could replace it). hc's own folders
(`/run/user/<uid>/herdr-core`, `~/.local/state/herdr-core/<session>`) pass. The first check that
passes pins the real path it reached, and every connection, probe included, goes to that path, so
a link changed later redirects nothing. A check that refuses, or a core that is gone, closes the
open connection and points the herdr API at nothing until a check passes again: health and what
is served agree. `OVIS_HC_ENV` is ignored under this policy. After a late first core start,
`hc_connecting` keeps the advert down until the initial status subscriptions are ready, including
for pages already connected. A later own Ovis identity is logged once without changing the
frozen fleet identity, as on the classic path.

The bridge explicitly passes the existing-only engine policy through
`setRuntime(runtime, "existing-only")` in `server/herdr-core/runtime.ts`, before constructing
services. The machine profile (`OVIS_PROFILE=machine`, a preview that starts only with `OVIS_PREVIEW=fleet` beside it,
which no release sets) passes that same policy for classic herdr and
for herdr-core; ordinary serve passes `"ordinary"`, which may start a core through `hc connect`. The policy has no default: every entry names it.
The shared `server/fleet/product-engine.ts` selects and rechecks the engine, and
`server/fleet/runtime-identity.ts` reads or creates the frozen identity record. Under the
existing-only policy, all connections (including background users and replacements) open the
selected native Unix socket directly, using the generation 1 framed protocol that `hc connect` forwards. There is no engine-starting subprocess in this path. Each
replacement connection uses the same rule, and adapter startup also requires a successful
socket probe. A probe followed by `hc connect` alone could race a core exit and start a new one.
Ordinary Ovis keeps its existing startup behavior.

The machine profile serves a herdr-core the same way. `OVIS_PROFILE=machine` (with `OVIS_PREVIEW=fleet`) with `OVIS_RUNTIME=herdr-core`,
or a saved `runtime-<PORT>.json` choice of it, selects the core; nothing discovers a runtime by
itself. Which core: `HC_SOCKET`, else `HC_SESSION` resolved as hc resolves it (`socket` in
`$XDG_CONFIG_HOME/herdr-core/config.toml`, else `<session>.sock` under `$XDG_RUNTIME_DIR/herdr-core`,
else under `$XDG_STATE_HOME/herdr-core/<session>/`), else the only core that answers among this
account's sessions, as above. A selected socket that is absent stays
selected. `OVIS_HC_BIN`, else the usual install folders, the `PATH` and the login shell's `PATH`, names
the `hc` whose `--version` is read when the first core that passes the check is found, before
Ovis's adapter starts: once per server process, and again only if that `hc` file disappears from
disk while the server runs (then every candidate is asked `--version` afresh, at most every 10 s).
That version read is the only `hc` the profile runs; it also runs the owner's login shell to read
the terminals' environment and the `PATH`, which is not `hc`. Ovis never starts a core, but hc may:
while a terminal of a core is open, hc's own `hc hold` starts that core again within a few seconds
after it is killed, with or without Ovis running. Stop a core with `hc server stop`. With the core absent, killed or not yet started, the server keeps answering, and
authenticated `/api/health` reports it in `machine_profile` (`engine: "herdr-core"`,
`runtime_down: true`, `reason`) as for classic herdr; requests that need the engine fail as they
do there. The core is asked again every two seconds; once it answers, the same server process
serves it with the same `web_ui.boot_id`, and its log repeats the `Machine engine:` line. Text
typed while it was down is not sent. The profile's adapter listens in its own private temporary
folder, as the bridge's does, and stopping the server closes only that adapter and its connection.

The herdr-protocol adapter listens at
`<private mkdtemp($TMPDIR/ovis-fleet-hc-)>/herdr-core.sock` (0700 directory, 0600 socket), removed
on bridge shutdown. It is separate from the engine's socket and from the own Ovis state.
Authenticated bridge health and fleet `bridge.json` identify the native socket; `/api/bridge`
identifies the private adapter through which its herdr API is served. The advert's `boot_id`
is the existing lifetime digest of the native socket's device, inode and nanosecond birth time,
accepted after a successful framed hello. It is `awaiting-herdr-core` before the first answer.
A bridge restart keeps it; a core restart changes it. Session snapshots use that same native
lifetime, so a bridge restart also keeps the browser's draft in place. A real core restart moves
the old draft to **Recover unsent text** until the user puts it back into a message box; nothing
is sent automatically. The durable core ID from hello never replaces the PC's frozen `runtime_id`.

Health derives terminal attachment from `capabilities().attach === "hc"`. Core streams need no
classic PTY host. `runtime_down` separately reports whether the selected engine is usable.
Multiple Ovis servers can stream and type into the same core terminal at once; neither viewer is
held. Opening, typing in or resizing a viewer lets that viewer set the terminal's geometry,
which both see. Browser history scrolling stays local, and an unsent draft remains local.

Agent chat, screen-read cards and status have the same support as an ordinary Ovis on herdr-core.
The fleet bridge adds no agent integration: chats that require a herdr session report still
cannot use one, and an agent must supply status through the paths ordinary Ovis already reads.
The isolated QA uses a Claude-shaped local transcript and menu, with OSC 7501 status reports;
it does not claim support for a paid agent or fix missing agent reports.
