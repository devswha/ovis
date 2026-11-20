import { afterEach, expect, spyOn, test } from "bun:test";
import { relayDevice } from "../relay/test-helpers.ts";
import { ACCOUNT, listedPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function recentlyPromoted() {
  const { fixture, service, member: elder } = await listedPc(closes);
  const time = { now: Date.now() + 3_600_001 };
  const clock = spyOn(Date, "now").mockImplementation(() => time.now);
  closes.push(() => clock.mockRestore());
  const { devices, accountMailbox } = fixture.app.context.services;
  const recent = await relayDevice(fixture);
  devices.linkAccountKey(recent.id, recent.publicKey, recent.publicKey, ACCOUNT);
  const { spki: key } = await phone();
  service.registerDevice(ACCOUNT, key, "Tablet");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const notice = devices.openNotices().find(n => n.key === key);
  if (!notice?.row) throw new Error("Expected the tablet admission");
  const id = notice.row;
  const approve = (addedBy: string) => devices.pairRelayApproved("Tablet", key, { path: "account", addedBy, id });
  expect(approve(recent.id)?.device.id).toBe(id);
  expect(devices.sessionRow(id)).toBeNull();
  time.now++;
  return { devices, elder, approve, id, key, notice: notice.id };
}

test("H1/T38: an established member's later digits release the same carried hold", async () => {
  const { devices, elder, approve, id, key, notice } = await recentlyPromoted();
  expect(approve(elder.id)?.device.id).toBe(id);
  expect(devices.sessionRow(id)).toMatchObject({ role: "drive", key });
  expect(devices.openNotices().some(n => n.id === notice)).toBe(true);
});
