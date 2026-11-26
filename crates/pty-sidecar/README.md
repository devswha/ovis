# ovis-pty-sidecar

The PTY host of every terminal the Ovis server runs itself (`server/pty/session.ts`), written in Rust:
it takes `<cols> <rows> <command> [args...]`, newline-delimited JSON control frames on stdin
(`i` input, `r` resize, `p` pause/resume output reads, `w` SIGWINCH at the current size), the pty's
bytes on stdout, and the child's exit code. Linux and macOS only.

Its stdin is bounded: a control frame longer than 17 MiB is discarded up to its newline, and once
16 MiB of input wait for a command that is not reading (each frame counted with 80 bytes on top of its
own, empty ones not queued), further input frames are dropped (one stderr line per overflow) while
resize, pause and stop frames keep working. The command runs as the
leader of its own process group, which the host kills whenever it ends: the command exiting, a stop
(stdin closed, SIGTERM, SIGINT, SIGHUP, SIGQUIT, a broken stdout) or a crash (SIGABRT, SIGSEGV,
SIGBUS, SIGILL, SIGFPE). A host killed outright (SIGKILL) cannot do that: on Linux the command itself
is killed with it (`PR_SET_PDEATHSIG`), and the rest of the group gets the pty's hangup. After the
command exits, its output is read until EOF, 200 ms of quiet or 2 s; output paused then is held for
up to 15 s.

## Where it comes from

On Linux and macOS this host is the default. Each release ships it (`.github/workflows/pty-sidecar.yml`),
and the plugin's build, each update installed from the app and `install.sh` put the binary for the
PC in `bin/ovis-pty-sidecar` beside the server, checked against the release's SHA-256
(`scripts/pty-sidecar.ts`). Without that binary, the server takes a local build:

```bash
cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml
bun run server
```

`OVIS_PTY_SIDECAR_BIN` points at a binary elsewhere (a leading `~/` is expanded, as the plugin's
`env` file is not a shell). Name the binary itself, or a wrapper that `exec`s it, so that the
server sees how the host ended.

## When it cannot run

Before the first use (at startup), the server runs the binary twice: with no arguments it must print
its usage line and exit 2, and `1 1 true` must exit 0. A missing file, one that is not executable or
not for this CPU (or in a folder mounted `noexec`), another program, a host that crashes or hangs
(3 s), or a PC where it cannot open a pty fails the check. The server then says once on stderr why,
and how to get a host that runs, and herdr's panes are mirrored instead of attached; a private
sign-in terminal is refused. A host that ends by a signal the server did not send (a crash, the
out-of-memory killer) ends that attach and is said on stderr; the next attach starts a new one.

A checkout of main whose `crates/pty-sidecar` no release was built from has no release binary to
install: the daily beta (`.github/workflows/beta.yml`) publishes one as the `pty-sidecar-<tree>`
prerelease, which `bun scripts/pty-sidecar.ts install` takes, and `cargo build` above works at once.
Remote PC bundles carry this host. Windows has no Rust host and mirrors.

## Checks

```bash
cargo test --manifest-path crates/pty-sidecar/Cargo.toml   # frame parsing
bun test server/pty/host.test.ts server/pty/session.test.ts   # PtySession on this host
```

The Rust checks in `server/pty/host.test.ts` are skipped when the binary has not been built. CI's
Rust PTY host job builds it and runs `cargo test`, `host.test.ts` and `session.test.ts` on it; the
jobs whose tests attach terminals build it too (`pty-host` in `.github/actions/setup-ci`).
