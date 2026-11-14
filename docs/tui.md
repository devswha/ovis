# Terminal client (`ovis tui`)

`ovis-tui` is the Ovis inbox in a terminal, for PCs that run herdr-core. It opens on the
inbox: the agents that wait for you first, then the ones working, the finished ones you have
not looked at, and the idle ones. The selected agent's question or permission card is beside
the list (on its own page on a narrow screen), with the last turn of its chat. A digit answers
the card. Enter opens the agent's terminal in a full terminal view with herdr-core's sidebar,
tabs and splits; the detach key brings you back to the inbox.

The inbox reads this PC's Ovis server, the same one the phone and the browser use, so what is
read, answered and waiting is the same everywhere. The terminals come from herdr-core directly
and work without the server: when no server answers, the inbox says so, names the address it
tried, and Enter still opens the terminals.

The terminal view is [hc-tui](https://github.com/followcat/hc-tui) (Apache-2.0), used as a
library at a pinned commit with a few small changes of ours (`crates/ovis-tui/patches/`). It is
not affiliated with or endorsed by hc-tui or the Herdr project.

## Run it

```bash
ovis tui                             # or, in a checkout: bun scripts/plugin.ts tui
```

The command finds the program (`OVIS_TUI_BIN`, else `bin/ovis-tui` in the install, else a local
build of the crate) and starts it with this install's server address and token. The token is
passed in the program's environment only. Released installs do not ship the program yet; until
they do, build it:

```bash
crates/ovis-tui/prepare.sh           # fetches the pinned hc-tui and applies our patches
cargo build --release --manifest-path crates/ovis-tui/Cargo.toml
```

The build needs Rust and Zig 0.16 (hc-tui builds Ghostty's terminal library with it).

The program also runs by itself: `ovis-tui --help` lists its options. It reads `HC_SOCKET` or
`HC_SESSION` (or `--session`) for herdr-core, and `OVIS_URL` (or `--url`, else `HOST` and
`PORT`, else `http://127.0.0.1:7317`) and `OVIS_TOKEN` for the server.

## Keys

Every action is a plain letter, digit or arrow, so a phone keyboard reaches all of them.

| Key | Does |
| --- | --- |
| `j` `k`, arrows | move |
| Enter | open: the card on a narrow screen, else the terminal |
| `1`-`9` | answer the card on screen |
| `t` | terminal |
| `d` `u` | scroll a long card |
| `m` | mark the finished agent read |
| `r` | read everything again |
| `b`, Esc | back |
| `?` | help |
| `q` | quit |

In the terminal view, hc-tui's detach key (`Ctrl+B q` by default, as set in your herdr config)
comes back to the inbox. A digit only answers a card with a single choice; a card that takes
several picks, steps or typed text is answered in the terminal. An answer goes out once, through
the server, and is never repeated by itself.

## On a phone over SSH

Narrow screens (45 to 60 columns, as in Termux or an iOS SSH app in portrait) get one column:
the list, then the card, then one terminal. The key hints fit 45 columns. Where the terminal
reports taps, a tap on a row opens it and a tap on `‹` goes back. For `Ctrl+B` use the extra
keys row's CTRL.

When the connection drops, the client ends with it. Run it again and it opens where you were:
the same terminal, card or row (the place is kept in `$XDG_STATE_HOME/ovis/tui.json`, without
anything you typed). Nothing you typed is sent by a reconnect: words left in an agent's input
box stay there unsent.

- **tmux:** run the client inside tmux on the PC (`tmux new -A -s ovis 'ovis tui'`)
  and a dropped connection does not end it; `tmux attach` shows it as it was. tmux keeps
  `Ctrl+B` for itself, so the detach key becomes `Ctrl+B Ctrl+B q` (or bind herdr's detach to
  another key).
- **mosh:** the session survives sleep and network changes without running the client again.
  mosh sends the keys you typed while the network was gone once it is back: that is mosh's own
  behaviour, not the client's. Use SSH with tmux if anything typed offline must not arrive later.

## Limits

- herdr-core only: the inbox reads a classic herdr server too, but its terminals do not open in
  this view.
- Linux and macOS. Windows is not supported.
