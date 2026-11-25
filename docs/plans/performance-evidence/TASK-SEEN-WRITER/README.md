# TASK-003: Seen serialized writer evidence

Base: `1d71a718db4e0318c2d7d3f3a80c3e8c939e36c1`. Synthetic data only; no production impact claim.

## Design and limits

- One serialized lane per SeenStore; at most MAX_SEEN (500) accepted acknowledgements and 500 pane moves, including the in-flight operation. The separate limits keep retryable requests from crowding out one-shot move notifications. Excess acknowledgements use the existing `seen_unwritable` error handling. No coalescing; identical/older updates reach the head and skip persistence.
- Stage from the last committed map, await private temporary-file write/fsync/atomic rename, then replace memory and publish. Failed operations do not poison the lane or contribute to a later merge.
- Damaged bytes are copied privately and synced before replacing `.bad`; the original stays in place until the final atomic rename. Generic synchronous `writeStateDocument` is unchanged.
- `close()` rejects new work and drains accepted operations. ServerInstance.stop returns that drain; signal/disconnect shutdown awaits it before process exit. Local and remote move callbacks catch async errors. The managed launcher forwards signals to the child, which owns this drain.
- JSON schema, success payloads and events are unchanged. Saturation uses the existing persistence-error response (500), not a new wire code. File reading on initialization/first effective update and JSON/map work remain synchronous. Multiple independent owners of the same stateDir remain unsupported.

## Reproduction

```sh
mkdir -p "$HOME/.cache/ovis-tmp/seen-writer"
TMPDIR="$HOME/.cache/ovis-tmp/seen-writer" bun scripts/seen-writer-benchmark.ts > docs/plans/performance-evidence/TASK-SEEN-WRITER/results.json
TMPDIR="$HOME/.cache/ovis-tmp/seen-writer" bun test server/seen.test.ts server/seen-writer.test.ts server/core/status.test.ts server/conventions.test.ts
```

`results.json` includes all five repetitions, Bun/OS/architecture, counts, elapsed times and raw event-loop gap samples. No warmups. The sync control reproduces the original map-copy/whole-file-replace/map-rebuild algorithm using the unchanged sync helper. The async modes exercise SeenStore. The slow variant inserts an event-loop turn per persistence; the unit fixture is stronger: it holds persistence on an explicitly released barrier while unrelated work runs. Timing is distribution-only, never a pass threshold.

| Answer chars | Mode | Writes / batch | Bytes / batch | Median elapsed ms | Median maximum event-loop gap ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 128 | sync baseline | 50 | 4744642 | 8.872 | 8.868 |
| 128 | async | 50 | 4744642 | 17.857 | 1.130 |
| 128 | slow async | 50 | 4744642 | 17.639 | 1.090 |
| 2048 | sync baseline | 50 | 52744642 | 22.850 | 22.850 |
| 2048 | async | 50 | 52744642 | 32.165 | 1.269 |
| 2048 | slow async | 50 | 52744642 | 34.295 | 1.287 |

This trades throughput overhead for yielding during persistence; it does not reduce write amplification. These host measurements are not comparable to the historical Linux audit as a speedup ratio.

## Validation

- RED: new durable-publish/drain barrier test timed out on the synchronous implementation because it never entered the injected writer.
- GREEN: 226 tests / 1004 assertions across Seen, writer, core status and server conventions passed. Covers ordered increasing/older/equal IDs, restart, bounds, failed-first-write recovery, pane moves, MAX_SEEN eviction, schema/malformed/unreadable documents, damaged-copy/final-rename failure, and private modes.
- `bun run check fast` was run: generated types/themes, typecheck and build passed; unit lane failed (24231 pass, 148 fail, 655 skip). Failures span unrelated platform/shell/fixture suites; do not claim a green gate. `scripts/conventions.test.ts` rerun reproduces a pre-existing fixed-wait ratchet failure in untouched `scripts/relay-new-pc-press-regression.ts:180`.
- Final gate result and any further checks are recorded in the PR. Browser/integration/native Windows/container hook lanes have not been run locally. No UI change or live herdr session was used.
