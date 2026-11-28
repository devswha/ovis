---
name: verify-ui
description: Verify a browser UI change in an isolated session with a separate verifier agent, never the author agent grading its own work. Use when a change touches src/, index.html, site/demo/ or UI styling and layout, or before opening a UI PR that needs browser regression runs and before/after screenshots.
---

# Verify a UI change

An agent that wrote a UI change already knows which path it built for and tends to test only that
path. UI verification runs in a **separate verifier subagent or session** with fresh context: the
author runs `bun run check fast`, then hands the checkout to a fresh verifier that grades the screen
from the outside.

## Hand-off to the fresh verifier

Give the verifier only what a reviewer or user knows:

- **Give:** the worktree path, the base commit (`origin/main`), `git diff --stat origin/main`, one
  short paragraph stating the user-visible behavior or bug being fixed, and dedicated directories
  under `~/.cache/ovis-tmp/<name>` for `TMPDIR` and `UI_EVIDENCE_DIR`.
- **Withhold:** step-by-step click scripts, internal state explanations, and assurances about edge
  cases. The verifier chooses its own interactions to try to break the change.

## Safety rules

- **Never touch the user's live herdr session.** Strip `HERDR_SOCKET`, `HERDR_ENV`, `HC_SOCKET` and
  session IDs (`scripts/browser-checks.ts` and `scripts/verify-ui.ts` strip them automatically), and
  capture screenshots only from the disposable demo or an isolated test session (`ovis-test`), never
  a live one.
- **Never stop `herdr-web-main.service`** (the maintainer's main test app, AGENTS.md). Leave it
  untouched; for reproducible `before` screenshots, run `verify-ui.ts`
  against a clean `origin/main` checkout so both `before` and `after` use identical demo or test
  fixtures.
- **Never bind `0.0.0.0`.** Automated checks bind `127.0.0.1` on `port: 0`. A throwaway preview for
  a person binds `HOST=$(tailscale ip -4)` on a free port.
- **Keep `/tmp` clean.** Set `TMPDIR=$HOME/.cache/ovis-tmp/<name>` (`mkdir -p` first) and delete it
  once the evidence has been copied or inspected.

## Verification steps

### 1. Run the matched CI browser regressions

From the worktree under review, find and run every CI browser script covering the changed files:

```bash
mkdir -p ~/.cache/ovis-tmp/ui-check
TMPDIR=~/.cache/ovis-tmp/ui-check bun scripts/browser-checks.ts --limit 0 --run
```

When a shared component (`FilesDialog`, `RepoChanges`, the sidebar, selection/focus, or the terminal
view) changed, run all `scripts/*-regression.ts` and `scripts/*-qa.ts` that cover it **in the CI
runner image** before the PR is ready for review, even when the new behavior is opt-in.

### 2. Run the 4-cell baseline matrix and capture screenshots

Probe desktop (`1280x800`) and phone (`390x844`) across both `dark` and `light` themes, checking that
React mounts past `.boot` without `.app-crash`, `pageerror`, `console.error`, `5xx` responses, theme
mismatches or horizontal viewport overflow:

```bash
TMPDIR=~/.cache/ovis-tmp/ui-check \
  bun scripts/verify-ui.ts --evidence ~/.cache/ovis-tmp/ui-evidence --label after
```

For a visual change that needs before/after screenshots on the PR, also capture `--label before`
from an `origin/main` checkout on the same fixture setup and inspect every saved PNG
(`desktop-dark`, `desktop-light`, `phone-dark`, `phone-light`) directly. A baseline older than
`scripts/verify-ui.ts` is served on loopback and probed from this checkout with `--url`.
Captures shown to the maintainer are the light ones only (`desktop-light`, `phone-light`).

### 3. Try to break the touched surface

Write a short untracked probe (`scripts/verify.tmp.ts`, deleted afterwards) using `withDemoBrowser`
from `scripts/demo-browser.ts` (taking `newContext` from the session by name) or `appContext` from
`scripts/app-context.ts`, with bounded condition waits (`waitForFunction` / `locator.waitFor`, never
fixed sleeps), and exercise:

- **Dismissal and Back:** `Escape`, clicking outside a sheet or menu, and phone `Back`
  (`page.goBack()` / `history.back()` where `usePhoneSheetBack` applies) close the surface cleanly,
  restore focus, and leave no stuck backdrop or history trap.
- **Narrow and crowded inputs:** `390x844` phone viewport, long unbroken paths/identifiers, empty
  lists, error states and CJK/long-label copy neither clip controls nor cause horizontal scroll.
- **Theme and tokens:** check both `dark` and `light` modes; colors come from `src/styles.css`
  tokens (`DESIGN.md`), and any new `t("…")` copy renders in place.
- **Demo parity:** if the feature can be reached in the browser demo, verify `site/demo/transport.ts`
  answers its `/api/*` routes and WebSocket frames without unexpected 404s.

## Reporting back

Return a concise verdict to the author session:

1. Exact commands and CI browser scripts run.
2. Evidence paths (`before` / `after` PNGs and `*-report.json`).
3. Adversarial interactions tested (viewport, theme, keyboard/Back, edge inputs).
4. **PASS** or **FAIL** — on any **FAIL**, name the reproduction steps, the failing cell/selector
   and the offending `file:line`. Do not patch the code inside the verifier unless asked; let the
   author fix the root cause and re-run a fresh check.
