# Add a machine to your Ovis account by one line (trial)

A trial for a Linux x64 machine whose user runs classic herdr (protocol 22 or newer): one pasted line installs a
separate trial Ovis server there and adds the machine to an account of a TEST account service; one line undoes it. The
trial server talks only to the three test services named in the line: the app, the account service and the relay.

## The kit

A folder of exactly five files:

| File | What it is |
| --- | --- |
| `bin/ovis-server` | the compiled server (`bun scripts/build-server.ts linux-x64 <dir>`), built from a commit that has the machine profile |
| `bin/bin/ovis-pty-sidecar` | the Rust terminal host (`crates/pty-sidecar`), linux-x64 |
| `bin/bin/ovis-pty-sidecar.json` | the host's record the server checks it by: its SHA-256 and the server's version |
| `join.sh` | the join and its undo |
| `SHA256SUMS` | `<sha256>  <name>` for the four files above, nothing else |

The trial's add runs under the fleet preview, so the words it prints name the line's app (`OVIS_RELAY_APP_URL`) and the
trial's own command (`ovis-trial`, by its absolute path), as the QR code's offer does.

Make it, from a checkout with nothing but the two programs, into an empty folder outside the checkout (`make` refuses a
folder that holds anything, and any folder inside the checkout):

```sh
bun scripts/join/kit.ts make --server <ovis-server> --pty <ovis-pty-sidecar> --out <dir> \
  --url <kit address> --relay <wss://relay origin> --account <https://account origin> --app <https://app origin>
```

Print the line again for a kit folder that already exists (it checks every file against SHA256SUMS first, and refuses a
folder that holds anything else); for the same address and origins it is the same line, byte for byte:

```sh
bun scripts/join/kit.ts line --kit <dir> \
  --url <kit address> --relay <wss://relay origin> --account <https://account origin> --app <https://app origin>
```

Each prints the line on stdout and nothing else there. Serve the folder as it is at the kit address (`https://`, with a
path if you like, or `file://` for a folder the machine can read).

## The two lines

On the machine, in a terminal of the user that runs herdr (never as root):

```sh
sh -c '...' ovis-join '<kit address>' <sha256 of join.sh> <sha256 of SHA256SUMS> '<relay>' '<account service>' '<app>'
```

The line hands `join.sh` the flag `--trial`: a trial kit refuses to join without it (exit 31), and leaves the machine as it was before the line ran (the line's
own download folder is removed again), because a
later join of the product will reuse an Ovis already on the machine, and in this trial that would add the person's daily Ovis to
the TEST account. With `--trial` the trial server is separate, and an Ovis the machine runs is never touched, restarted
or added. `--session <name>` (and `--yes`, for scripts) may be added at the end. It fetches `join.sh` into a temporary folder and
runs it only if its SHA-256 is the one in the line. On a system other than Linux it refuses at once (exit 17); the
download stops after 120 s; an INT, TERM or HUP before `join.sh` runs removes the temporary folder (exit 130).
`join.sh` then:

1. looks, reading only: which herdr sessions of this user listen (sockets this user owns), and refuses with one line
   when there is none, only herdr-core, a herdr below protocol 22, or root;
2. chooses the session (`--session <name>`, else the only one, else a question at the terminal);
3. shows what it allows, in English and Korean, with the three origins, and waits for `yes`;
4. fetches the kit's files and checks each against `SHA256SUMS`, by exact name; `SHA256SUMS` must have the SHA-256
   given in the line and list exactly the four files, each once (a fifth name, a missing or repeated one, or a file
   that differs is refused, nothing installed). Over `https://` only those four names are fetched, so nothing else on
   the server is ever read; a `file://` folder must also hold nothing beside the five files;
5. installs them in `~/.local/share/ovis-trial` (with a receipt of everything it makes, and its own copy of `join.sh`
   for the undo);
6. starts `ovis-server serve` there as the user service `ovis-trial.service` (or in the background where no user service
   manager answers), with these settings: `OVIS_PROFILE=machine` with `OVIS_PREVIEW=fleet` (the machine profile is a
   preview, which a server refuses to start without it; the interlock's probe server gets both too), a port of its own (17690-17699, or
   `--port`), its own state folder (`~/.local/share/ovis-trial/state`, which the server makes at its first start: the
   join writes nothing in it), `OVIS_RUNTIME=herdr`, the chosen session's socket, the three origins and
   `OVIS_TELEMETRY=0`, and `OVIS_HERDR_BIN`: the program of the herdr server that listens on that socket, read from its
   process (`/proc/<pid>/exe`), never a herdr found on PATH (a machine may hold several); never `HOST` or `OVIS_TOKEN`.
   `NODE_EXTRA_CA_CERTS` is carried only when the login sets it (never set by the join), and the consent then says so.
   Its output, from the unit as from the background start, goes to `~/.local/share/ovis-trial/logs/server.log`;
   Before anything is written it refuses (exit 33) a trial state folder that leads, through any link, into an Ovis
   default folder (`~/.config/ovis`, `~/.config/herdr-web-ui`, or one under them): a server started there would answer
   with that Ovis's relay key;
7. waits until the trial server's port answers, from the trial's own `bin/ovis-server`, then reads `/api/health` on the
   server's owner socket (`~/.local/share/ovis-trial/state/serve.sock`) until it names the machine profile and says
   that terminals attach; a server with no owner socket, or whose health does not name the machine profile, is stopped
   and everything is rolled back (exit 29). The machine profile refuses some folders, and the join then passes its words
   on and rolls back: a state folder it will not start on (one another account could change, or that another server wrote
   to first) ends the run with the sentence the server wrote to its log (exit 35; the same for the interlock's probe,
   whose state folder is a temporary one, under `TMPDIR`); a herdr socket it will not use, because a folder on its path
   could be changed by another account, ends it at once with that folder named (exit 36); a herdr session that does not
   answer the trial server within 90 s ends it with the server's reason (exit 26);
8. runs today's add for that server (`~/.local/share/ovis-trial/bin/ovis-trial add`), under the fleet preview: a
   sign-in code, then the add names the account it signed in to and waits for Enter, then a QR code that a phone of the
   account scans. It needs a terminal for that: without one the add refuses, and the join ends with exit 30.

One condition for running it:

- Show the pairing QR code only to your own phone, in private: whoever sees it within its ten minutes could add this machine to another account (no screen sharing, no recording, no log).

The undo, printed by the join:

```sh
sh ~/.local/share/ovis-trial/join.sh --uninstall
```

The join never makes a link inside the trial folder. So the join (a run again too), the undo and every `ovis-trial`
command first look for one, and for the folder itself being a link: finding one, they refuse (exit 14) before
anything is written, read for a decision or signalled, and name the link. `ovis-trial stop` says the server stopped
only once it saw its process end; otherwise it says what it could not tell and exits non-zero. Where no user service
manager answers, the trial server runs in the background, and `ovis-trial stop`, the undo and every rollback find it by
one rule: a process of this account whose program is the trial's `bin/ovis-server` and whose command line is exactly
`<that program> serve`. `run/server.pid` is not trusted for this, and no other process is ever signalled; a server that
does not end within 10 s of TERM and then KILL is named, and the undo then removes nothing (exit 14).

The port: a port another program already listens on is refused (exit 14), on a run again once the previous trial
server is stopped, and a health answer counts only when the program listening on the port is the trial's own
`bin/ovis-server` (read from `/proc`). When the unit is present, the undo needs the user's service manager to answer
and the service to read inactive after the stop; otherwise (from `su` or `sudo`, say) it refuses (exit 14) and
removes nothing. When the pairing gate does not read `closed` after the add, the trial server is stopped first, then
reported stopped (exit 34). Every stop that must hold (exit 34, a refusal after the start, a rollback that keeps the
install) disables the service and stops it, and is said done only once the service reads inactive and not enabled.
The unit runs `serve.sh`, which starts the server with `env -i` and exactly `server.env` (systemd does not read that
file); a value holding a quote or a backslash is still refused (exit 2), for other readers of the file. The join asks the
trial server's port on 127.0.0.1 only whether it is alive; everything else (its health, its pairing gate, its account
status, for the join and the undo) it reads as the server's local owner, on its owner socket `state/serve.sock`, which
only this account can connect to (`Host: localhost`, no `Origin`). Neither goes through a proxy the login names.

The undo takes nothing it removes from the receipt: the receipt only says that a join happened and where the trial
folder is. It removes the trial's unit only at the one path the join writes it, and only when its first line is the
join's marker (`# Written by the Ovis trial join for <trial folder>`); the trial folder itself; and lingering, if the
join turned it on. A receipt or unit that does not fit is refused (exit 14) and nothing is removed; a run again refuses
such a folder the same way, before anything is written. Outside the trial folder it removes only the folders the join
made on the way to it or to the unit (`~/.local/share`, `~/.config/systemd/user`, ...), deepest first and each only when
it is empty. When lingering cannot be turned off, it says so and gives the `loginctl disable-linger` command. It stops the trial server, removes its service and its folder (programs, identity, state), turns lingering off again if the join turned it on, and says what became of the machine's entry in the account.
The undo removes its own `join.sh` with the folder, so running the same undo line a second time ends with the shell's
`cannot open ... join.sh` (exit 2): there is nothing left to undo.

## Exit codes, and Ctrl+C

`join.sh` exits 0 when the machine is in the account, 30 when the trial server runs but the add did not finish and the
server names no account (the folder stays, `ovis-trial add` finishes it), 37 when the add did not finish but the trial
server names an account, which the join cannot confirm is the one signed in to (rolled back, as a refusal is), and a
code from 2 to 36 for a refusal (its list is at the head of `join.sh`). A HOME holding a line break or another control
character is refused first (exit 2). Ctrl+C at a question ends the join with 130, a HUP with 129, nothing changed.
Ctrl+C, TERM or HUP (a dropped SSH connection) after the yes, before the add (the download, the check of the kit's
server, the start, the wait for it to answer), and TERM or HUP during the add, roll back as a refusal does and say what
is left, with the undo line if anything is (130, 143 or 129); the roll back does not depend on a terminal to print to. Ctrl+C at the QR code ends only the add: the
join prints its ending and exits 30; the shell around it may still report 130 for the whole session (`script(1)` did in
the container tests), so a caller should read `ovis-trial status` and the account, not that code.

Once the machine is in the account, the join reads `security.pairing_gate` from the trial server's health (on its owner
socket) and requires
`closed` (the relay closes it); otherwise it says so and exits 34. Under the test switch, a server whose health names no
gate is let through with that said.

Nothing is put in front of the trial server's port: the join adds no `tailscale serve` entry and no proxy,
so the undo has none to remove.

## What it leaves alone

- herdr: never installed, started, stopped, updated or restarted, by the join, the trial server or the undo. The only
  herdr command the join runs is `herdr status server`, which reads the running server's answer.
- An Ovis this machine already runs: its process, port, state, relay key, token and config are never read, copied or
  changed. Of another Ovis the join reads only its command line, to say in the question that it exists.
- The machine's entry in the account: nothing on the machine can take a machine off the account's list today (the add's
  sign-in lives in memory only and is signed out when the add ends). The undo says so and points to the guide's
  section on the account's PCs (docs/guide.md, "Through an account").
- What was done on the machine through Ovis while it was joined (files written, agents installed).

## What the checks protect against, and what they do not

The line pins `join.sh` and `SHA256SUMS` by SHA-256, and `SHA256SUMS` pins every other file by exact name: a download
that broke off, a file that changed on the server or in transit, a name added to or missing from `SHA256SUMS`, or a
kit other than the one the line was made for is refused before anything is installed. Over `https://` the join
cannot see what else the server holds: it fetches only the names `SHA256SUMS` lists and reads nothing else there (a
`file://` folder with any other file is refused). It does not protect against whoever
gives you the line: the line itself, and the address it names, are trusted (through HTTPS, or the folder's own
permissions for `file://`).

## The trial's own command

`~/.local/share/ovis-trial/bin/ovis-trial add | status | stop | start`: `add` and `status` are the plugin's commands,
run from a clean environment (only HOME, PATH, SHELL, TERM, LANG, LC_ALL, LC_CTYPE, XDG_* and the session bus pass) with
`HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR` set to the trial's own folders: the plugin reads the settings of
its config folder over its environment, and unset, that folder is another Ovis plugin's. `stop` and `start` go to the
trial's service. `ovis-trial` exports `OVIS_PROFILE=machine` and `OVIS_PREVIEW=fleet` to the plugin, which then reads the
trial server on its owner socket, as the profile's record `state/serve.lock/http.json` names it; its TCP port answers
only whether it is alive.

## Tests

- `bun test scripts/join/kit.test.ts` (run by CI): the line printed again from a kit folder is the one its making printed,
  and `sh -n` parses join.sh.
- `OVIS_JOIN_CONTAINER_QA=1 bun test scripts/join/join.contract.test.ts` runs both lines in containers of the CI runner
  image and the systemd image (`ovis-join-systemd:local`, which the test builds from `scripts/join/systemd-qa.Dockerfile`
  on the CI runner image when it is missing), against the repository's test account service and Bun relay behind a test TLS proxy, on a
  docker network with no way out. It needs `OVIS_JOIN_HERDR_BIN` (a real herdr 0.9 program, mounted read-only into the
  containers) and `OVIS_PTY_SIDECAR_BIN` (a built Rust terminal host), and builds the server unless `OVIS_SERVER_BIN`
  names one, and `OVIS_JOIN_PLAIN_SERVER_BIN`: a server built without the machine profile, for the
  interlock's refusal and the open pairing gate (exit 34), which the machine profile never shows. CI does not run it: without `OVIS_JOIN_CONTAINER_QA=1` the whole file is skipped. It runs on a machine with
  docker and the CI runner image, by hand before a change here is pushed (the PR's Validation says when it ran).
- The test switches below work only with a kit made by `kit.ts make --test-kit`, which carries a file `TEST-KIT` that its
  SHA256SUMS lists (and the line pins SHA256SUMS, so a pasted line cannot add it). A kit made without the flag ignores
  them, and the join says so in one line when they are set.
- TEST SWITCH, for containers only and never offered to a person: `OVIS_JOIN_TEST_PLAIN_SERVER=1` lets a kit whose server
  is the plain one (no machine profile) through the interlock. The consent then says so, and that such a server also
  listens on the machine's home-network and Tailscale addresses once the relay is on. With it, and only with it,
  `OVIS_JOIN_TEST_ADD_DONE=1` counts the add as done without a device, so the check of the pairing gate after the add
  can be tested. Such a server has no owner socket: with the switch, and only with it, the join reads it on its port.
