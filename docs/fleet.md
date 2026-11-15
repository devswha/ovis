# Fleet

A fleet is a set of machines that one PC of yours runs from Ovis. That PC is the **controller**. Every other machine
is a **fleet machine**: it runs your terminals and agents, and you open it from Ovis like any other PC. The controller
keeps the list of machines and decides who may sign in.

This file is the user guide. The wire contract is [fleet-link.md](fleet-link.md); a machine's bridge beside its herdr
or herdr-core session is described in [fleet-product-bridge.md](fleet-product-bridge.md).

## Where the controller runs

Every PC that opens fleet machines needs a token: set `OVIS_TOKEN` on it (a long random value, for example from
`openssl rand -hex 32`) before you turn the fleet on, and restart Ovis there. Without one, every local process on that
PC, and anyone who can forward a port to it, counts as the PC itself ([relay.md](relay.md#a-pc-with-no-screen)), so
the fleet stays held until the token is set:

- turning the fleet on (`ovis fleet on`), minting invites, confirming machines and removing one answer
  `fleet_token_required` (`ovis fleet` exits 8) and nothing is written;
- no machine signs in or enrols; each one shows **This controller has no OVIS_TOKEN** and keeps trying by itself
  (`ovis-link status` says `refused: auth_failed (fleet_token_required)`);
- the machine list and the invites still show, so you can see why.

Once the token is set and Ovis restarted, the machines sign in again with no new invite.

From your phone or another PC, reach that PC as a paired device: a paired device gets in without the token
([guide](guide.md#access-and-safety)), and one paired to drive can confirm machines through the relay, while one that
only watches can read the fleet and change nothing. Scripts and the `ovis fleet` commands on that PC use the token from
the plugin's config (`OVIS_TOKEN=<token>` in its `env` file).

## Turning the fleet on

Run this once on the controller:

```sh
ovis fleet on
```

It makes the fleet's **owner key** and shows its **recovery phrase** once. Write the phrase down and keep it somewhere
safe, away from the PC. It is shown only on a terminal, or written into a new file you name with
`--phrase-file <path>` (mode 0600). It never appears in a log, an error or a web page, and a second `ovis fleet on`
shows nothing.

Lost the controller's state folder? `ovis fleet on --restore` puts the owner key back from the phrase. It never
replaces an owner key that is already there.

## Adding machines

Adding a machine takes three steps: an invite, the join on the machine, and your confirmation.

**1. Make invites.** On the controller:

```sh
ovis fleet invite --out <folder> --count 5
```

Each invite is one file (mode 0600) and works once. It expires after an hour unless you pass `--ttl` (60 s to 24 h).
The invites of one run form a **batch**. `ovis fleet invite --line` prints an invite as one line instead, only on a
terminal. The Fleet screen can also download new invites as one archive.

An invite is a secret. Anyone who has it can try to join your fleet with it until it is used, withdrawn or expired.
Withdraw one you no longer need: `ovis fleet invite --withdraw <invite>`, or `--withdraw --batch <batch>` for a whole
batch.

**2. Join on the machine.** On the machine, `ovis-link join --state <dir> --invite -` joins with the invite on stdin
and `ovis-link run --state <dir>` keeps the machine connected ([fleet-link.md](fleet-link.md)); the machine's bridge,
`ovis-server remote` beside its herdr or herdr-core session, writes the advert the link agent reads
([fleet-product-bridge.md](fleet-product-bridge.md)).

A batch of fresh machines started at the same time spreads its first sign-ins over about 10 seconds, so they do not
all queue at the relay together.

**3. Confirm.** A new machine waits as `pending-confirmation` (`ovis-link status` on the machine says so too) until you
confirm its batch:

```sh
ovis fleet confirm <batch>
```

It shows each machine of the batch with its fingerprint and asks before it confirms exactly that set. Compare the
fingerprints with the ones the machines printed if you can. From then on the machines sign in by themselves, also after
a restart of either side.

## The Fleet screen

Open it from **Settings → Devices and PCs → Open fleet**, or from the **Fleet machines** caption in the sidebar. The
Settings entry is a preview: it shows only while the server runs with `OVIS_PREVIEW=fleet`, which no release sets. It
lists every machine with:

- its state, and in plain words why it cannot be reached when it cannot (removed, on hold, waiting for confirmation,
  its runtime down, and more);
- how it connects (directly on your network, or through the relay);
- when it was last seen.

The owner confirms batches there after reading the fingerprints, removes machines and downloads new invites. A device
paired only to watch sees the same lists without those controls. On a PC without `OVIS_TOKEN` the screen says how to
set it.

`ovis fleet list` shows the same in a terminal, with each machine's alerts. Add `--all` to see removed machines too.

Each fleet machine also shows in the sidebar as a PC of its own, labelled **through the fleet link**. When one PC is
both a fleet machine and an SSH or relay PC of yours, it shows as one row that names both routes.

## How machines connect

A machine dials the controller; the controller never dials the machine. It goes through the Ovis relay, or directly
when the machine can reach the controller on the same network (the same PC, a container or VM on it, or your LAN).
A machine on the relay tries the direct way again from time to time and moves over when it works.

The connection is end-to-end encrypted between the machine and the controller. The relay passes it on but cannot read
or change it. A machine talks only to the controller its owner key signed: it refuses any other.

When many machines come back at once (say, after the controller restarts), they sign in in turn instead of all at once.
On Ovis's hosted relay that is 22 machines a minute, so a large fleet takes a few minutes to be all back.

## Removing a machine

```sh
ovis fleet remove <machine>
```

Or press **Remove** on the Fleet screen. The machine's key is refused from then on, also with a fresh invite, and its
connections end at once. Programs already running on the machine keep running there: removing a machine cuts it off,
it does not wipe it. To let a removed key back in, run `ovis fleet readmit <machine id>`.

Other cases:

- **A machine you rebuilt or lost.** Make new invites for the same slots with
  `ovis fleet invite --out <folder> --slots-from <batch>`. A machine that joins with one takes over the old slot under
  the same name, and the old key is refused.
- **A machine that is gone for good.** A machine unseen for longer than its batch's retention (24 h by default; set it
  with `--retention` when you make the invites) is removed by itself.
- **Two copies of one machine key.** When two machines sign in with the same key, the controller notices. A copy that
  stays silent raises an alert in `ovis fleet list`. Two that both answer, or six silent copies within a day, put the
  key on hold (quarantine). `ovis fleet release <slot>` revokes that key and frees the slot for a new invite.
- **A state folder restored from a backup.** The controller notices it and lets no machine sign in until you run
  `ovis fleet confirm --restored`. A machine removed after the backup stays out.

## Keys and secret files

These files hold secrets. Each is written with mode 0600, so other accounts on the same computer cannot read it.

| File | Where | What it lets someone do |
| --- | --- | --- |
| The owner key (`<state>/fleet/owner.json`) | the controller | Sign controllers into the fleet. Today it lives on the controller PC, so someone who steals that PC has it, as they have the controller key. The recovery phrase is the same key in words. |
| The machine key (`machine.key`, named in `fleet.json`) | each fleet machine | Sign in as that machine. It cannot open terminals elsewhere, pair a device, make invites or remove machines. It never leaves the machine. |
| The bridge's descriptor (`bridge.json`, beside `advert.json`) | each fleet machine | Holds the bridge token, so it gives the same control as `advert.json`. The bridge writes it while it runs. |
| `advert.json` | each fleet machine | Holds the bridge token: control of every terminal the machine's bridge serves. The link agent reads it. |

**What this means for agents on a fleet machine.** The bridge token in `advert.json` and `bridge.json` is protected
from other accounts, but not from your own. Any program that runs as your account on that machine can read it. That
includes every program you start in a fleet terminal, and every agent. So an agent on a fleet machine can, if it tries,
take over the other terminals of the same machine: read them, type into them, stop them. It cannot reach other
machines of the fleet this way, and it cannot reach the controller.

Treat every terminal of one fleet machine as one room. Do not run an agent you do not trust next to work it must not
touch: give it a machine of its own.

## Running commands on a machine

`ovis start <machine> [--agent <id>] [--cwd <dir>] [--env K=V]... [--message <text>] [--wait <s>] -- <command>` starts a
program on a machine in a terminal of its own and types its first message once the program says it is ready: one JSON
line with the terminal, exit 0 when sent, 5 when held (it waits in the pane's pending messages). `ovis wait <machine>
<terminal> --until idle,blocked,done [--timeout <s>]` waits for the terminal's state: exit 0, 124 on the timeout, 3
when the program ended first.
Both need the machine's bridge server (`ovis-server remote`); a bridge on herdr or herdr-core answers `ovis start`
409 `unsupported_runtime`. Details: [fleet-link.md](fleet-link.md), "`ovis start` and `ovis wait`".

## Known limits of release 1

Release 1 is the first usable fleet. These are its known limits.

**How it is tested.** The release trial runs on one small set of machines on one home network and one tailnet: a Linux
desktop, two Macs, two Windows VMs and about 15 Linux containers on one PC, joined by invite and forced onto the relay. It
is meant to show joining, confirming, one row per machine, reconnecting after controller and machine restarts, about
20 machines coming back at once, and both direct and relay connections on three operating systems.

It does not show how the fleet behaves across different public networks and routers,
when separate hardware fails on its own, on other Linux distributions or cloud kernels, or over real long distances.

**One PC reporting another PC's id.** A fleet machine that reports the id of another of your PCs shows inside that
PC's row, labelled **through the fleet link**. It never receives that PC's traffic: each route keeps its own
connection.

**Platforms.**

- A fleet machine runs Linux or macOS, on x64 or arm64. Windows cannot be a fleet machine: there is no link agent
  for it.

**Security.**

- The owner key lives on the controller PC, beside the controller key. Keep the PC safe, and keep the recovery phrase
  off it.
- Programs on one fleet machine can read that machine's bridge token (see
  [Keys and secret files](#keys-and-secret-files)).
