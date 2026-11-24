# TASK-COPY evidence: copy-on-demand plain text (TASK-001 / TASK-002)

Scope: an assistant turn's TXT copy button (`src/components/ChatView.tsx`). Before this change,
the row derived the answer's plain text on **every render** (`text={plainText(answerText)}`),
so a long answer paid a full markdown→plain-text pass each time it re-rendered — including on
every streaming word — even when the reader never copied it. After this change the conversion
runs only inside the click gesture that asks for it.

## The gate (count-based, deterministic)

`src/components/ChatView.copy.test.tsx` renders one assistant turn through `react-test-renderer`
and counts `plainText` invocations (the spy delegates to the original implementation, so copied
output stays byte-for-byte the legacy form):

| Scenario | `plainText` calls before | `plainText` calls after | clipboard writes |
|---|---|---|---|
| render an answer (heading/bold/fence/link) | 1 per render | **0** | 0 |
| render + stream new words in, then TXT click | ≥2 | **1** (in the click) | 1 |
| render + MD click | 1 per render | **0** | 1 |
| render + TXT click, order recorded | 1 per render | **1** (derive → copy) | 1 |

AC-002 (zero conversions until a TXT copy is asked for) and AC-006 (one clipboard write per
click, gesture semantics unchanged) are asserted on counts and on the exact copied string, never
on timing.

## Output parity (byte-for-byte)

`plainText` was moved verbatim to `src/lib/plainText.ts` (same five replacements); the MD copy
still passes the answer as written, and the TXT copy now derives it in the click handler. The
test asserts `copyText` receives exactly `originalPlainText(answer)` for a markdown answer whose
plain form differs from it, so MD/TXT output is unchanged byte-for-byte.

## Timing (observation only — not asserted, not a claim about any device)

These are isolated component fixtures on one host (`bun test`, no live browser, no live herdr
session). They show the shape of the win — a long answer no longer pays a conversion pass per
render — but are **not** a production measurement and carry no ms threshold:

- Before: one `plainText` pass per render of an assistant row; a streaming answer re-runs it on
  every word.
- After: zero passes while rendering; one pass per TXT click.

No wall-clock number is recorded here as a gate; if a timing observation is wanted later it goes
in a separate note, labelled synthetic, per `docs/performance-audit-2026-10-21.md`.

## Isolation

No live herdr session, no `--takeover`, no real port: the test renders components directly with
stubbed browser globals and a mocked clipboard write.
