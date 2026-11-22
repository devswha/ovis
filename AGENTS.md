# Ovis

Browser UI for the herdr terminal multiplexer: a React 19 + xterm.js client (`src/`), a Bun
backend (`server/`) that bridges herdr's unix-socket API, and the wire contract both import
(`shared/`). herdr owns every pty, scrollback and agent state; this app is only a bridge.

These files hold only the traps the code and tests do not show. Setup and the checks are in
[CONTRIBUTING.md](CONTRIBUTING.md); the release steps and the settings made once outside the
repository are in [docs/development.md](docs/development.md). Code conventions (imports, CSS tokens, i18n entries, fixed
sleeps, wording, icons) are enforced by the `conventions.test.ts` files, whose failures say what
to change. Also read [server/AGENTS.md](server/AGENTS.md) and [src/AGENTS.md](src/AGENTS.md).

## Bridge traps
- One herdr RPC connection per call: herdr closes the socket after each answer. Only
  `events.subscribe` stays open, and a second subscribe on it is ignored, so reopen with the full
  set. Caching answers is fine.
- `pane.process_info` takes `pane_id`, not `target` (with `target` herdr answers for the focused
  pane).
- Never rebuild an attached terminal from `pane.read`: the attach stream is the truth. Only a
  mirrored pane (Windows, or no PTY host: neither the Rust host nor Node) is drawn from
  `pane.read`, so never assume a pty exists.
- Nothing the user typed is sent automatically after a disconnect: it waits in a draft until the
  user sends or discards it.
- Prompt answers go through `POST /api/pane/prompt/answer`, never guessed digit keys.

## Tests and QA
- Tests never touch the user's herdr session or real state: they use the isolated test session.
- Screenshots and recordings come from the demo or a test session, never the user's live one.
- An Ovis server an agent starts for someone to open binds to this PC's Tailscale address
  (`HOST=$(tailscale ip -4) PORT=<free port> bun run server`), never `0.0.0.0`. Moving a port that
  `tailscale serve` already fronts to the Tailscale address breaks that HTTPS address.
- Never stop the maintainer's "herdr main" test app (`https://home-server.tail1e211e.ts.net:17421`,
  user unit `herdr-web-main.service`): it serves the latest main by itself.
- Mac and iOS Simulator checks run on `ssh eamac` only, in a fresh `git clone` in `/tmp` that is
  deleted afterwards. Never drive the MacBook Pro (`ssh macbook`, `ssh mymac`): automation there
  takes over the maintainer's keyboard and focus.
- Native Windows checks run on `ssh winvm` only, one run at a time, never on `home-window` (the
  maintainer's own PC):
  `ssh winvm "pwsh -File C:\ProgramData\winvm\Invoke-InSession.ps1 -Command '& C:\ProgramData\winvm\pr-check.ps1 -Pr <N>'"`.
  When a run leaves state behind, `winvm reset`, then `winvm start`.
  CI's runner holds the VM's lease while it runs (`winvm status` says `ci-winvm-runner`): stop it
  with `systemctl --user stop ovis-winvm-runner` (it finishes a job in progress), take the lease,
  and `systemctl --user start ovis-winvm-runner` after `winvm release`.
- On this PC `/tmp` is a small tmpfs that runs out of inodes: run checks and review checkouts with
  `TMPDIR=$HOME/.cache/ovis-tmp/<name>` (create it first, delete it when done).

## Maintainer workflow
- A merge goes through `pr-merge <PR>` only (`pr-merge --help`; `--check` prints the gates and
  merges nothing). It never passes `--admin`.
- These stay an open PR until the maintainer gives his word: a release, the README, a UI change
  he has not seen (before and after screenshots first), an HTTP/WS contract, a workflow change
  that removes or weakens a check or touches secrets, permissions, triggers or fork handling, and
  an outside contributor's feature or docs PR. A PR he tests himself waits for his word too.
- Never push a `v*` tag by hand: installed updaters act on tags alone.
- One session that edits files per worktree. A session never removes the worktree it runs in, and
  removes another only when no agent is working there and `git status` there is clean: with
  `herdr worktree remove --workspace <id>`, never `git worktree remove`.
- Everything written to git and GitHub (commits, branches, PRs, reviews, issues, changelog
  fragments) is in English.

## This fork
- To put a change on Ricardo's own Ovis (the VPS, `https://vps.tailb4e5ae.ts.net:8443`, which
  `tailscale serve` fronts from 127.0.0.1:7317), run `bun scripts/deploy-vps.ts`. It builds, restarts
  the server, checks the new bundle from omarchy and restarts the Xiaomi app. Say it's deployed only
  once it exits 0; when it stops at the Xiaomi, ask Ricardo to swipe Ovis away and reopen it.
- There Ovis runs on herdr-core (hc), with no herdr: the checkout `/home/ricardo/Projects/forks/ovis`
  started by `bun scripts/plugin.ts start` from the systemd user unit `ovis.service`, the layout INSTALL.md
  describes for a PC with hc and no herdr, pointed at the checkout instead of `~/.local/share/ovis/app`.
  The unit hands plugin.ts `HERDR_PLUGIN_CONFIG_DIR=~/.config/ovis` and `HERDR_PLUGIN_STATE_DIR=~/.local/state/ovis`;
  its settings are `~/.config/ovis/env` (`OVIS_RUNTIME=herdr-core`, `OVIS_HC_BIN`, `OVIS_AUTO_UPDATE`,
  the app name, telemetry and screen bridge), next to the state. herdr is stopped there:
  `herdr.service` is disabled (its unit link was removed; the file stays in the orchestrator repo's
  `vps/systemd`), the herdr plugin `devswha.ovis` is disabled, and its settings in
  `~/.config/herdr/plugins/config/devswha.ovis` are kept. The terminals Ovis shows there are hc's.
  The deploy script no longer drives the plugin setup.
- It works from any machine: elsewhere it runs itself on the VPS over SSH (`OVIS_DEPLOY_SSH`, default
  `ricardo@vps`), after `git pull --ff-only origin main` there, so it deploys origin/main, not your
  checkout. Push or merge first; it warns when HEAD is not on origin/main. It stops, changing nothing,
  while the VPS checkout is on another branch (a PR under test there, as `feat/screen-window-title`
  was), whether run from elsewhere or on the VPS itself, where it does not pull: switch it back to main
  there first.
- `deploy-vps` restarts with `systemctl --user restart ovis.service` and sets `OVIS_AUTO_UPDATE=1` in
  `~/.config/ovis/env` (read on every start of the unit, a reboot's too). From then on the VPS's updater installs by
  itself each newer plain `vX.Y.Z` tag of its origin, such as the fork's calendar tags
  (`v2026.1101.1`, pushed by the orchestrator's weekly job; upstream's are `v0.x.y`). The Xiaomi app is
  not restarted by that: swipe Ovis away and reopen it. The phone's adb serial is its tailnet address,
  `100.101.250.35:5555` (`OVIS_DEPLOY_ADB_SERIAL`).
