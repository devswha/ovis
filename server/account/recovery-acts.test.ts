/**
 * What the recovery socket does with each act of `ovis recover` (device-row-states rows T70, R11, P7, P23, S22): it
 * parses the act with the shared contract, lists the waiting rows with why each can or cannot be released, releases
 * only releasable rows (journal first), and undoes releases whole.
 */
import { expect, test } from "bun:test";
import { RecoveryReleases, type RecoveryCandidate, type RecoveryJournalEntry } from "./recovery.ts";
import { recoveryActs } from "./recovery-acts.ts";

const row = (id: string, extra: Partial<RecoveryCandidate> = {}): RecoveryCandidate => ({
  id, key: `key-${id}`, label: `Row ${id}`, origin: { from: "remote", how: "list" }, waiting: "catching_up",
  joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, ...extra,
});

function setup(options: { logReadable?: boolean; failJournal?: boolean } = {}) {
  const journal: RecoveryJournalEntry[] = [];
  const releases = new RecoveryReleases({ journal: (entry) => { if (options.failJournal) throw new Error("disk full"); journal.push(entry); } });
  releases.registerRecoverySource(() => [row("0123456789abcdef"), row("fedcba9876543210", { frozen: true }), row("aaaaaaaaaaaaaaaa", { waiting: null })]);
  const acts = recoveryActs({ releases, logReadable: () => options.logReadable ?? true, user: "owner" });
  return { acts, releases, journal };
}

test("T70: list names every waiting row and why it can or cannot be released", async () => {
  const { acts } = setup();
  const answer = await acts({ act: "list" }) as { rows: { id: string; refusal: string | null }[] };
  expect(answer.rows.map((entry) => [entry.id, entry.refusal])).toEqual([["0123456789abcdef", null], ["fedcba9876543210", "frozen"]]);
});

test("T70: release lets in only releasable rows, journalled under this PC's user", async () => {
  const { acts, releases, journal } = setup();
  expect(await acts({ act: "release", rows: ["0123456789abcdef"] })).toEqual({ released: ["0123456789abcdef"] });
  expect(releases.releaseOf("0123456789abcdef")).not.toBeNull();
  expect(journal[0]).toMatchObject({ kind: "release", by: "owner" });
  expect(await acts({ act: "release", rows: ["fedcba9876543210"] })).toEqual({ error: "fedcba9876543210 cannot be released: frozen" });
  expect(await acts({ act: "release", rows: ["bbbbbbbbbbbbbbbb"] })).toEqual({ error: "bbbbbbbbbbbbbbbb does not wait here" });
  expect(releases.releaseOf("fedcba9876543210")).toBeNull();
});

test("P23: nothing is released while the log cannot be read", async () => {
  const { acts, releases } = setup({ logReadable: false });
  expect(await acts({ act: "release", rows: ["0123456789abcdef"] })).toEqual({ error: "0123456789abcdef cannot be released: log_unreadable" });
  expect(releases.releaseOf("0123456789abcdef")).toBeNull();
});

test("T70: a failed journal write releases nobody", async () => {
  const { acts, releases } = setup({ failJournal: true });
  const answer = await acts({ act: "release", rows: ["0123456789abcdef"] }) as { error?: string };
  expect(answer.error).toContain("nothing was released");
  expect(releases.releaseOf("0123456789abcdef")).toBeNull();
});

test("T70: undo ends releases, and an act the contract does not parse is refused", async () => {
  const { acts, releases } = setup();
  await acts({ act: "release", rows: ["0123456789abcdef"] });
  expect(await acts({ act: "undo", rows: null })).toMatchObject({ releases: [expect.any(String)] });
  expect(releases.releaseOf("0123456789abcdef")).toBeNull();
  expect(await acts({ act: "release", rows: ["not-a-row-id"] })).toEqual({ error: "Invalid recovery action" });
  expect(await acts({ act: "remove", targets: ["0123456789abcdef"] })).toEqual({ error: "remove is not available on this PC yet" });
});
