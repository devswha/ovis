# ovis-acp-keeper

Holds one ACP agent for any number of clients and a terminal screen. The keeper starts the agent
on pipes and is its only ACP client: it sends `initialize` and `session/new` (or `session/load`)
itself, so the screen works with nobody else attached. Ovis and the screen in a herdr-core pane
then use the same session at once. Nothing in Ovis starts it yet.

```
ovis-acp-keeper ROOT [--cwd DIR] [--name NAME] [--resume 'CMD {session}'] [--session-meta JSON]
                [--load SESSION] [--headless] -- AGENT [ARGS...]
```

ROOT is a directory private to the user (0700). The keeper keeps there:

| File | What |
|---|---|
| `archive.jsonl` | every JSON-RPC line in either direction and the keeper's own `_keeper/*` notes, one numbered row each: `{"seq","dir","ts","raw"}` with `dir` `to-agent`, `from-agent`, `keeper` or `to-client` (those also carry `"client"`) |
| `acp.sock` | clients connect here (on Windows `acp.pipe` names the pipe) |
| `keeper.lock` | held while a keeper runs; a second keeper in the same ROOT exits with `another keeper is running in ROOT` |
| `process.json` | the keeper's and the agent's pid, and the agent's systemd scope |
| `agent.stderr` | the agent's stderr, appended across restarts |

A client sends `{"replay":N}` and gets rows N.. from the file, a
`{"through":seq,"pid":pid,"client":conn}` watermark, then live rows. Its requests reach the agent
under an id of the keeper's own, and the answer comes back as a `to-client` row for that `client`
with the client's own id: clients that count ids alike never get each other's answers (client
numbers go on across restarts of the keeper in the same ROOT, so no row in the archive is
addressed to an earlier client of the same number), and one
client reusing an id still in flight gets error -32600. An agent request (an approval) is archived
under a keeper id too (`agent-N`; `fs/*` and `terminal/*` requests, answered by the keeper
itself, keep the agent's id), so an answer meant for one approval never resolves a later one the
agent asks under the same id. It waits for the first answer from the screen or any client; that
answer alone goes to the agent, under the agent's own id. The screen answers only the card it has
drawn: a key that arrives before a new card is on screen is not taken as an answer to it.

## Notes in the archive

| Note | When |
|---|---|
| `_keeper/ready`, `_keeper/session`, `_keeper/first_frame`, `_keeper/agent_exit` | start, session opened or loaded, first screen drawn, agent ended |
| `_keeper/resolved`, `_keeper/dropped` | the answer that went to the agent and who sent it; a later answer that did not |
| `_keeper/auto_answered` | the agent asked for `fs/*` or `terminal/*`, which the keeper does not offer |
| `_keeper/client` | a client connected, with its number |
| `_keeper/rejected` | a client reused an id it still has in flight |
| `_keeper/oversize` | a line longer than 64 MiB was dropped (`dir`, `bytes`, `id`); a request among them is answered with an error so nobody waits for it (unless its id is longer than 64 KiB: then the note has no id) |
| `_keeper/expired` | on restart: an approval the agent that asked it can no longer receive (`_keeper/resolved` is written before an answer goes out, so an approval the agent received is never expired) |

## Ending and starting again

The agent leads its own process group. When the keeper ends (SIGTERM, SIGINT, SIGHUP, Ctrl+Q on
the screen, or the agent exiting with `--headless`) it sends the group SIGTERM, SIGKILL after
1.5 s, and stops the agent's scope. On
Linux the agent also dies with a keeper killed outright (`PR_SET_PDEATHSIG`). Where the user's
systemd is reachable, the agent runs in a transient scope named after ROOT
(`acp-keeper-<hash>.scope`), which holds the helpers that leave the group (a broker that calls
`setsid`); a keeper that starts in a ROOT whose keeper died stops that scope before it starts the
agent, so the agent's session is free to load. The group and the scope are ended as soon as the
agent exits, not when the screen closes. A user systemd that cannot be reached leaves the agent
without a scope (and an earlier scope unstopped).

Started again in the same ROOT, the keeper numbers on from the last whole row (a row cut short is
dropped), notes `_keeper/expired` for each approval nobody answered, and loads the last session it
noted, unless `--load` names another one. When the agent cannot load the noted session it gets a
new one; when it cannot load the one `--load` names, the screen says so and there is no session.
Nothing restarts a keeper by itself yet.

## Screen

Without `--headless` and on a terminal it draws the shared screen (conversation, tool calls,
approval cards, mode and model pickers). It keeps the newest 1000 entries or 1 MiB of text and
tool input (a tool's input over 256 KiB is not kept for the screen), and
draws at most one frame per 33 ms, so a long session or a flood of output costs bounded memory and
never holds up reading the agent; the archive keeps everything.

## Checks

```bash
cargo test --manifest-path crates/acp-keeper/Cargo.toml
```

The tests in `tests/keeper.rs` run the keeper against `examples/fake_agent.rs`, a scripted agent,
and need Linux. The ones about helpers that leave the process group need a user systemd and are
skipped, with a line saying so, without one. macOS and Windows build (`cargo check --target
aarch64-apple-darwin`, `--target x86_64-pc-windows-gnu`): on macOS the process group is all the
keeper ends, on Windows only the agent itself.
