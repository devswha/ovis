/**
 * The lock where access is decided (device-row-states rows P11, S24, N1-N7, R7, T46): with a lock in this PC's log, a
 * row not approved at this PC's screen, a loopback window without screen proof and every grant that is not a row are
 * refused, while this PC's own programs keep working. A PC in no account offers no lock.
 */
import { afterEach, expect, test } from "bun:test";
import { pairingPc, memberRow, signIn, ask, type Pc } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

const BRIDGE_TOKEN = "b".repeat(64);

async function lockedPc() {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, bridgeToken: BRIDGE_TOKEN } });
  pcs.push(made);
  const receipt = made.app.context.services.safetyLog!.appendLock({ account: "acct_1" });
  expect(receipt.outcome).toBe("applied");
  return Object.assign(made, { member });
}

test("T46: a locked PC refuses a row not approved at its screen, through the relay", async () => {
  const made = await lockedPc();
  const signed = await signIn(made, made.member.row.id, made.member.key);
  if ("error" in signed) return;
  const tried = await ask(signed.link, "/api/devices");
  expect([tried.status, tried.body.error?.code]).toEqual([403, "locked"]);
});

test("N4: a locked PC refuses a loopback window that gave no screen proof", async () => {
  const made = await lockedPc();
  const tried = await made.local("/api/devices");
  expect([tried.status, tried.body.error?.code]).toEqual([403, "locked"]);
});

test("N6: this PC's own programs keep working while it is locked", async () => {
  const made = await lockedPc();
  const tried = await made.local("/api/session", { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } });
  expect(tried.status).not.toBe(403);
});

test("T46: an unlocked PC is as before", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  expect((await made.local("/api/devices")).status).toBe(200);
});

test("T46: a PC in no account offers no lock", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  const tried = await made.local("/api/account/lock", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
  expect([tried.status, tried.body.error?.code]).toEqual([409, "not_bound"]);
  expect((await made.local("/api/account/lock")).body.bound).toBe(false);
});
