# scripts/world: the one test world

One command gives a relay, a test account service and machines on classic herdr or herdr-core, in a sealed docker
network of its own, pinned to the band of the heavy slot it runs in, and removes it all again. Use it instead of
building a test setup of your own.

## Get a world
Every world runs inside a heavy slot of this PC, whatever its size:
`~/.ovis-toolchain/heavy-run.sh [-t SECONDS] -- bun scripts/world/cli.ts run ... -- <command>`. The slot gives the band
(OVIS_HEAVY_SLOT and OVIS_HEAVY_CPUS, such as 116-127): every container is pinned to it and read back, `--cpus` may only
repeat it, and a world never outlives the slot: its deadline, and each container's own `timeout`, is at the latest
OVIS_HEAVY_DEADLINE, when heavy-run.sh ends the slot (its start plus `-t`, at most 1800 s); a slot that does not export
it is refused. The tool keeps no copy of heavy-run.sh's slot table (it went from four slots of 16 CPUs to six and then
eight, and heavy-run.sh publishes none): it takes the band when it is a
set of this PC's online CPUs (one range, or whole cores with their sibling threads) and exactly the CPUs the process runs on (heavy-run.sh's `taskset`), so a
set written by hand or left from another slot is refused. Outside a slot `up`, `run`, `add-machine`, `startWorld` and
the proof refuse; `down`, `ls`, `gc` and `describe` work anywhere, and so do `services up|status|down`, which by design
never run in a slot (below).
A world's name is its own on this PC: `up` refuses a name that docker already has objects of (another scratch root's
world, say), and a start that fails, its teardown and its reaper remove only objects labelled with its own owner.
The checkout under test needs `bun install` (it runs read-only and sealed). Keep scratch out of /tmp:
`export OVIS_WORLD_SCRATCH=$HOME/.cache/ovis-tmp/<you>/worlds`.

```sh
bun scripts/world/cli.ts up --machine m1:herdr --machine m2:core          # prints one JSON line, owns the world until killed
bun scripts/world/cli.ts run --machine m1:herdr -- bun my-check.ts        # OVIS_WORLD_FILE names the description; always torn down
bun scripts/world/cli.ts ls | gc | down --name <world> | describe <world> [--scratch-root <dir>]   (describe with no name: exit 2, says what it needs)
bun scripts/world/cli.ts add-machine --name <world> --machine m3:herdr:bare
```

```ts
import { startWorld } from "../world/world.ts";
await using world = await startWorld({ machines: ["herdr", "core"] });   // m1, m2
const m1 = world.machine("m1");
await m1.terminal("add", "bun scripts/plugin.ts add");                   // a real pty; m1.recording("add"), m1.type("add", "\r")
await world.call("approveOnLinkPage", code, "acct_owner", "github");     // any method of the fake account service
```
From another process (the command `run` starts, a script beside an `up`): `attachWorld()` (it reads OVIS_WORLD and
OVIS_WORLD_FILE) or `attachWorld(name)` gives the same machines, `call` and `token`; only the owner adds machines
and removes the world. The control API behind `call` and `token` is on the world's network, so the world's machines
reach it too, and so does every user of this PC: it has no secret (it lives as long as its test, and its tokens are the
fake's, for a sealed world). The seal keeps the world from the outside, not a machine or a local user from the control
API. M2's long-lived services are guarded (below).
`add-machine` starts its machine with the plan the world saved at its start (plan.json in its scratch folder): the
world's origins, passes, repo, CA trust, memory and band, never defaults. Run it inside the world's own slot (from the
command `run` starts, or beside `up` in that slot): from a slot of another band it is refused, since a world's
containers all stay on one band. A core machine added to a world started without one gets herdr-core's binary then.
A browser INSIDE a world (browser.ts): `insideBrowser(world.description)` starts Chromium in a container of the
world on its sealed network (the image's Playwright Chromium behind inside/browser.ts, driven from here over that
network), so a page reaches what the world's machines reach and nothing of this PC. Chromium also resolves the world's
hosts to its proxy and nothing else, accepts its certificate, and sends no UDP but through a proxy (no WebRTC, no
STUN). No route interception: the app's page policy and the account service's own CORS and redirects are what a test
sees; `device.requests()`, `device.offline(on)`, failed requests logged. It needs a world with an app site
(`--origin app=… --site app=<dir>`). The container is the world's (its band, deadline and owner): removed with it.
The person's sign-in on the fake: `--people <file>` (lines `name:passphrase`, mode 600, the form the account service's
`--people` takes) puts a page at <account origin>/link (code, passphrase, confirm; 10 wrong tries in ten minutes stop
everyone) and the real code's /v1 CORS in front of the fake; the fake's own sign-in routes that need no passphrase
(`GET /v1/signin/<provider>`, `POST /v1/signin/<provider>/device`) are refused then (403). The same file goes to the
real code as `--people`.
`machine.pairingLink(label)`: the link of the last QR code a terminal drew (`ovis add`), read offline (qr.ts);
`machine.qrLink(label, accept, ms)` follows the terminal as it writes and gives the first link `accept` takes (no polling).
`machine.serverCall(route, { state, port, method, body, headers })`: one call to an owner route of the server the
caller names (the state folder and port of a server it started), through `<state>/serve.sock` when that server has the
socket, over TCP otherwise, with the same URL and Host either way (inside/serve-call.sh, which true-form-desktop.sh's
owner calls use too). Headers go in a 0600 file in the machine, never on a command line; a serve.sock nothing answers
on fails loudly. Health is read over TCP (`machine.health()`).
`machine.memberDevice("member", link, passphrase)`: a scripted member device with no browser, run in that machine
(inside/member.ts): it signs in to the test account with the app's own device sign-in (the passphrase and the link go
on stdin, never on a command line),
pairs through the world's relay from `ovis add`'s link with the app's own relay transport, and calls the machine's
/api/account/link and /api/account/enroll with the app's own join steps (src/lib/account/join.ts). `"skip"`: a device
that never pairs (a pairing it made up), which the machine refuses (auth_failed).
`machine.serverStartFrom(<file>, argv?)`: a server from exactly a start-line file of NAME=value lines.
Per machine: `--user od=ovisusr` (this PC's uid, home /home/ovisusr), `--hostname od=true-form-desktop`, `--mount`
(parents owned by the machine's user); `machine.unit(name, argv)` (a systemd user unit), `machine.fakeTailscale(owner)`,
`machine.standIn()` (inputs, answers, asks, freeze, thaw, ask, finish).
Browser devices with routed requests (a world without an app site): `worldDevices(world.description, { shellDir })` and
`capture()` in devices.ts. That Chrome runs on this PC: every request but the world's is refused and logged by its
routes, WebSockets included, its pages have no WebRTC, and it sends no UDP but through a proxy.
In a browser of a world, never close a tab right after a form's POST navigation: Chrome loses about one such close in
four here (the tab stays, Playwright waits for it with no timeout). That was the proof's sign-in hang; leave the tab
open, or wait for its `load` first.

## The true-form-desktop stand-in
`--preset od=true-form-desktop[:0.4.22][:six-live][:demo]`,
artifacts from OVIS_STANDINS (~/.local/state/ovis-test-services/standins): one machine (classic herdr 0.9.5, systemd,
hostname true-form-desktop, 4g) whose user, with this PC's uid, is `ovisusr` unless OVIS_STANDIN_USER names another:
seven letters either way, so the true form's paths keep their lengths. The plugin's id in its folders is the
repository's own (herdr-plugin.toml). The default is the TRUE form, as on a long-lived install: the machine's Ovis 0.4.22 launcher and supervisor running a 0.5.1
server its own updater installed from a tag mirror (offline), direct connections on (turned on as Settings does), the
default herdr session live and the five test session folders dead with stale sockets, three agents, herdr-core
0.1.17's default core with four plain shells, a user manager degraded by ydotool. The 0.5.1 server is installed as
a user does it, from Settings (`POST /api/updates/install` with the offered revision; OVIS_AUTO_UPDATE stays unset), and a
second update folder of an earlier install (135360771fa3e7bd, two releases) is there as a leftover. Not reproduced, and said in its printout: the
direct carrier's listeners (7319 on the machine's home-network and tailnet addresses, its loopback upstream 127.0.0.1:35173),
which 0.5.1 opens only while its relay is on; the stand-in's relay is off. `:0.4.22` is 0.4.22 all the way down (it only offers the
update), `:six-live` keeps the five test sessions live, `:demo` adds an earlier demo's unit. Its bring-up prints which
form it is; the world's description carries it (`machines[].preset`).

## Options
- `--machine <name>:<herdr|core>[:all|engine|bare[:systemd]]`: what starts (engine, stand-in agent, server; only the
  engine; nothing), and a systemd user manager.
- `--mount <machine>=<host path>:<path>`: an extra folder in that machine, always read-only (an older Ovis checkout).
- `--herdr-bin <file>` (a herdr version of your choice, copied in), `--hc-bin <file>` (default ~/.local/bin/herdr-core, copied in).
- `--repo <checkout>`: whose relay, server and fake run. `--account real --account-repo <ovis-sh/account checkout>`:
  the account service's `bun run local` instead of the fake, from the checkout mounted read-only, offline (shown at
  afa04d4, with `--people`: its own link page and passphrase page).
- `--limits open|hosted` (hosted: 30 new connections a minute, 64 sockets per address), `--passes off|grace|enforce`.
- `--origin account|relay|app|kit=<url>` and `--site app|kit=<folder>`: the world answers for exactly those origins
  (M2's rehearsal uses the real four), `--trust-ca` puts the test CA in each machine's system store.
- `--cpus` (only the slot's own band), `--memory 2g`, `--ttl 3600`, `--outbound` (opt-in route out; default sealed).

## Why sealed is the default
Nothing in a world reaches the internet or a real Ovis service: its network has no route out, and its names resolve
only inside it. Programs reach out on their own: classic herdr starts two `curl` children toward herdr.dev at its
start (its agent-detection list and its update check). The seal stops them; they give up on their own timeouts and
neither `up` nor a server restart waits for them. `--outbound` opens
a route for a test that needs one.

## The systemd machine is privileged
`--machine <name>:<engine>:<start>:systemd` is the one kind that runs `--privileged`: systemd must write its own
cgroup tree, which docker mounts read-only for any other container (CAP_SYS_ADMIN, seccomp and apparmor unconfined do
not help: systemd stops at "Failed to create /init.scope control group: Read-only file system"). It gets a PRIVATE cgroup namespace, never the host's tree, keeps the
CPU pin, the memory cap and the sealed network, and only our own code and the join line under test run in it. It
powers itself off at the world's deadline (docker cannot wrap a systemd first process). It is sealed at the network
level only: the host's block devices are visible in it, so anything running as root there (systemd and its system
units, `docker exec -u 0`) reaches the host; the code under test runs as the machine's user (`runner`, or the one
`--user` names), with no capabilities and no sudo. Its image, `ovis-world-systemd:local`, is built once from
systemd.Dockerfile, in a heavy slot:
`~/.ovis-toolchain/heavy-run.sh -- docker build -t ovis-world-systemd:local -f scripts/world/systemd.Dockerfile scripts/world`.

## How it ends
1. The owner's handlers: on INT, TERM and HUP, and on a normal end of its process (`beforeExit`: a script that ends
without disposing its world). `process.exit()` and KILL skip them; the reaper finishes those. 2. A reaper in a session of its own, the one that finishes: once
the owner is gone (SIGKILL too, also in the middle of the owner's own teardown) it removes the world, again and again
until nothing is left. Nobody ends it before that: the owner, `down` and `gc` end it only as the last step of a
removal, having seen nothing left. 3. Every container ends by itself at the world's deadline (`timeout` inside it; a
systemd machine powers itself off). 4. `gc`, and every `up`, sweep what dead owners left. A scratch folder is removed
only when it is the world's own (named after it, holding the owner.json the tool wrote); anything else is kept and
said. owner.json goes last, so a removal killed part-way leaves a folder the next one still knows.
The owner must run in this PC's own process table: `gc` decides that an owner is gone by /proc/<pid> and its start
time, so an owner inside a container would look gone, and anybody's next `up` would remove its live world.
A TERM during the start calls the start off; the owner gives the docker call in flight a few seconds, and nobody ends
the reaper while a docker call naming the world still runs, so what such a call makes after the owner is gone is still
removed. A kill of the whole cgroup (a closed pane, a systemd scope) takes the reaper too, since `setsid` does not
leave the cgroup: then layer 3 bounds the CPUs and layer 4 removes the rest.
`bun scripts/world/proof.ts` gives its worlds a prefix of its own, so two runs at once never touch each other.
`bun scripts/world/proof.ts` shows each of these, and the pins, the seal, two worlds at once and both engines, each with
a case that makes its check say FAIL.

## M2's test services
`bun scripts/world/cli.ts services up|status|down [--account real --account-repo <checkout>] [--kit <folder>]`:
long-lived containers on 127.0.0.1:27542 (account), 27543 (relay), 27544 (kit), 27549 (control: on loopback only, never put on the tailnet by `tailscale serve`). It
prints the `tailscale serve` entries and runs none of them. They are named `m2-<name>-*` and sit on CPUs 0-55, beside
the CI runners and by design never in a heavy slot (a slot ends after 30 minutes; `services up` needs none), with at most 2 CPUs and 2 GB each, restarted
unless stopped, logs capped at three files of 10 MB.
The account service, the relay and the control API sit on an internal network on which this PC itself has no address
(docker's `inhibit_ipv4`): nothing on the PC reaches their own addresses, so the edge is the only way in, and it
refuses `/v1/test` and `/v1/test/*`. The edge answers on 127.0.0.1 and also on its own address on its docker network
(the PC has one there), with the same checks on both. (`services up` asks the account service for its keys from inside its container.)
The control API stays on loopback (scripts of this PC mint test tokens with it), but its `/token` signs anybody in, so
it answers only a request whose `X-World-Control` header carries the secret that `up` writes to
`~/.local/state/ovis-test-services/<name>/control.secret` (mode 0600, a new one each `up`); anything else gets 401. The
edge checks it, and so does the control server itself (the secret reaches it in its environment, compared in constant
time, every route but a `/ready` that says only the kind and the relay's public pass keys). The secret is never on a
command line, which any local user can read: docker gets it in a 0600 env file (`--env-file`, removed once docker has
read it), not in docker's own environment either, where a name such as PATH would steer docker itself. The same holds
for what a caller hands a machine's command (`Machine.exec` and `background` env, a token say) and for
`Machine.terminal`'s command line; what `Machine.type` types goes on stdin. A value with a line break cannot go in an
env file and is refused. A world's certs folder is its user's alone (0700) and both keys are 0600. So another user of this PC,
or a process of theirs, cannot sign in through it. What it does not stop: a process of the services' own user can read
the file, as it can read everything else of that user's, and anybody in the docker group can read the container's
environment, as they can do anything with docker. Not publishing the port was the other choice; it would have taken
the test tokens away from this PC's own scripts. Once those entries exist, the ports are open to the whole
tailnet, so `services up` REFUSES 27542-27544 (and the app's 17541) unless the account service asks a person for a
passphrase: `--account real --people <file> --account-repo <checkout>` (a people file, mode 600, which the real code
gets as its own `--people`). The fake stays off them, also with a people file (`--account-arg=<arg>` passes
any other argument to the account service; the `=` is needed for a value that starts with a dash). Tests use `--ports <account,relay,kit,control>`.
