import { afterEach, expect, spyOn, test } from "bun:test";
import { accountDeviceId } from "../../shared/account-records.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function atCapacity() {
  const pc = await createListedPc(close => closes.push(close));
  const time = { now: Date.now() + 3_600_001 };
  const clock = spyOn(Date, "now").mockImplementation(() => time.now);
  closes.push(() => clock.mockRestore());
  for (let i = 0; i < 64; ++i) pc.service.registerDevice(ACCOUNT, keyOf(`k-${i}`), `Phone ${i}`);
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.openNotices()).toHaveLength(64);
  expect(devices.has(accountDeviceId(pc.serverId, keyOf("k-63")))).toBe(false);
  const held = devices.openNotices().find(n => n.key === keyOf("k-0"));
  if (!held?.row) throw new Error("Expected the first phone's admission");
  return { ...pc, devices, time, row: held.row, notice: held.id };
}

test("P17/T53, G15: the ten-second hold ends at capacity without admitting a new row", async () => {
  const { devices, time, row } = await atCapacity();
  time.now += 9_999;
  expect(devices.sessionRow(row)).toBeNull();
  time.now++;
  expect(devices.sessionRow(row)).toMatchObject({ role: "drive" });
});
