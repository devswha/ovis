# ovis-tui

The terminal client: the Ovis inbox for herdr-core, with hc-tui's terminal view one key away. Users
read [docs/tui.md](../../docs/tui.md); this file is for working on it.

## Layout

- `client/`: the library `ovis-tui-client`. The server API (`api/`), the live subscription
  (`live/`), the inbox model (`inbox/`), the network worker (`net.rs`), the kept place
  (`resume.rs`) and the screen as state, keys and drawing (`ui/`). It knows nothing of a
  terminal and is tested with a fake server.
- `src/`: the program. Flags, the key map, the theme read from the user's herdr config, the
  terminal screen, and the hand-over to hc-tui (`terminal.rs`).
- `UPSTREAM` and `prepare.sh`: the pinned hc-tui revision. `prepare.sh` fetches it into
  `upstream/` (ignored by git) and applies `patches/`; run it after a checkout and whenever
  `UPSTREAM` or `patches/` change. The patches are `git format-patch` output of commits made
  in `upstream/`, each with its tests; hc-tui's own conventions apply to them.

## Checks

```bash
./prepare.sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The build needs Zig 0.16 for hc-tui's Ghostty library. `client/` alone (`cargo test -p
ovis-tui-client`) needs only Rust, but Cargo resolves the whole workspace, so `prepare.sh` runs first.
CI runs the same on a pull request that touches the crate (`.github/workflows/ovis-tui.yml`).
Tests wait for events, never for time: the fake server answers in order, and each test reads what
was asked once `settle` has returned.

## Release packaging (not done yet)

Released installs do not ship `ovis-tui` yet; `ovis tui` finds a local build or `OVIS_TUI_BIN`.
A second change should:

1. Build static binaries in CI for linux-x64 and linux-arm64 (`x86_64-unknown-linux-musl`,
   `aarch64-unknown-linux-musl`) and macOS (arm64 and x86_64), as `pty-sidecar.yml` does for the
   PTY host: `rustup target add`, Zig 0.16 on the runner, `prepare.sh`, then `cargo build
   --release --locked --target <triple>`. A musl build here is 11 MB, `static-pie linked`, and
   runs in a bare Alpine container.
2. Attach them to the release with a manifest (version, SHA-256 per platform) and build provenance,
   and install the one for the platform as `bin/ovis-tui`, which `scripts/plugin-tui.ts` already
   looks for.
3. Ship hc-tui's `LICENSE` and `NOTICE` beside the binary (Apache-2.0 section 4) and Ghostty's
   MIT license text.

A one-line install on a headless Linux box then needs nothing but the binary and a herdr-core.
