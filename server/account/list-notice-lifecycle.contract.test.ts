import { afterEach, expect, test } from "bun:test";
import { createListedPc } from "./listed-pc.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const listed = () => createListedPc(close => closes.push(close));

test("G15/T57/P8: local Revoke removes the listed row and frees its notice slot", async () => {
  const { fixture, device } = await listed();
  const { devices } = fixture.app.context.services;
  expect(devices.openNotices().map(n => n.row)).toEqual([device.id]);
  expect(devices.revoke(device.id)).toBe(true);
  expect(devices.has(device.id)).toBe(false);
  expect(devices.openNotices()).toHaveLength(0);
});
