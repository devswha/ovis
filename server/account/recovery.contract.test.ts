/**
 * `ovis recover` against a real server (device-row-states rows R11, T70, P23, S19): with the release flag on the
 * server opens the recovery socket in its state folder and answers it; with the flag off it opens none. While the
 * log cannot be read, the list still answers and nothing is released.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bounded } from "../relay/test-helpers.ts";
import { pairingPc, type Pc } from "./pairing.test-helpers.ts";
import { askRecovery, RECOVER_DIR, RECOVER_SOCKET } from "./recovery.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });
const unix = process.platform !== "win32";

test.if(unix)("R11: with the flag on, the server answers ovis recover on its recovery socket", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "list" }))).toEqual({ rows: [] });
});

test.if(unix)("R11: with the flag off, the server opens no recovery socket", async () => {
  const made = await pairingPc({ server: { accountOpensAll: false } });
  pcs.push(made);
  expect(existsSync(join(made.stateDir, RECOVER_DIR, RECOVER_SOCKET))).toBe(false);
});

test.if(unix)("P23: while the log cannot be read, ovis recover still lists, and releases nothing", async () => {
  const made = await pairingPc({ startRelay: false, server: { accountOpensAll: true },
    prepare: (dir) => { writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 }); } });
  pcs.push(made);
  made.app.context.services.recoveryReleases!.registerRecoverySource(() => [{
    id: "0123456789abcdef", key: "key-a", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up",
    joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, lastSeenAt: null,
  }]);
  const listed = await bounded(askRecovery(made.stateDir, { act: "list" })) as { rows: { id: string; refusal: string | null }[] };
  expect(listed.rows.map((row) => [row.id, row.refusal])).toEqual([["0123456789abcdef", "log_unreadable"]]);
  expect(await bounded(askRecovery(made.stateDir, { act: "release", rows: ["0123456789abcdef"] }))).toEqual({ error: "0123456789abcdef cannot be released: log_unreadable" });
  expect(made.app.context.services.recoveryReleases!.releaseOf("0123456789abcdef")).toBeNull();
});

test.if(unix)("S19/P23: a log that turns unreadable after the start is read at each act: nothing is released or undone, and list says why", async () => {
  const made = await pairingPc({ startRelay: false, server: { accountOpensAll: true } });
  pcs.push(made);
  const releases = made.app.context.services.recoveryReleases!;
  releases.registerRecoverySource(() => [{
    id: "0123456789abcdef", key: "key-a", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up",
    joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, lastSeenAt: null,
  }]);
  expect(await bounded(askRecovery(made.stateDir, { act: "release", rows: ["0123456789abcdef"] }))).toEqual({ released: ["0123456789abcdef"] });
  writeFileSync(join(made.stateDir, "account-log.json"), "not json", { mode: 0o600 });
  const listed = await bounded(askRecovery(made.stateDir, { act: "list" })) as { rows: { refusal: string | null }[] };
  expect(listed.rows.map((row) => row.refusal)).toEqual(["log_unreadable"]);
  expect(await bounded(askRecovery(made.stateDir, { act: "undo", rows: null }))).toEqual({ error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" });
  expect(releases.releaseOf("0123456789abcdef")).not.toBeNull();
});
