import { afterEach, expect, spyOn, test } from "bun:test";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { bounded, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { createListedPc } from "./listed-pc.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { STALE_READ_MS } from "./account-devices.ts";
import { ask } from "./pairing.test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { parseSnapshotPage } from "../../shared/account-snapshot.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

test("T56: a failed service past one hour closes account-only sessions and refuses their sign-ins and requests", async () => {
  const clock = new TestClock();
  const epoch = Date.now();
  let correction = 0;
  const time = spyOn(Date, "now").mockImplementation(() => epoch + clock.now() + correction);
  closes.push(() => time.mockRestore());
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  devices.useClock(clock);
  clock.advance(JOIN_HOLD_MS);
  const schedule = clock.setTimeout.bind(clock);
  spyOn(clock, "setTimeout").mockImplementation((fire, ms) => schedule(fire, ms === STALE_READ_MS ? ms - 1 : ms));
  // Refresh through the real mailbox with the PC clock installed, not by supplying staleness to the row store: the
  // hour below counts from this whole read
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const session = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await session.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(session, "/api/account/status")).status).toBe(200);
  const errors: string[] = [];
  session.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) errors.push(frame.payload.code); };
  pc.service.opensAll = false;

  clock.advance(STALE_READ_MS - 1);
  correction = 60_000;
  await accountMailbox.pull();
  expect((await ask(session, "/api/account/status")).status).toBe(200);
  correction = -1;
  clock.advance(1);
  await session.flush();
  expect(errors).toEqual(["auth_changed"]);
  await expect(ask(session, "/api/account/status")).rejects.toThrow();
  const refused = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let hold: unknown;
  refused.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) hold = frame.payload.hold; };
  void refused.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]).catch(() => undefined);
  expect(await bounded(refused.serverError)).toBe("held");
  expect(hold).toEqual({ reason: "catching_up" });

  pc.service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const recovered = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await recovered.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(recovered, "/api/account/status")).status).toBe(200);
});

test("T56: a request at the monotonic hour is refused before timer delivery", async () => {
  const clock = new TestClock();
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  devices.useClock(clock);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  closes.push(() => wall.mockRestore());
  const session = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await session.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(session, "/api/health")).status).toBe(200);
  // Advance the clock reading independently of its callback queue (a busy event loop).
  const elapsed = spyOn(clock, "now").mockReturnValue(STALE_READ_MS);
  closes.push(() => elapsed.mockRestore());
  await expect(ask(session, "/api/health")).rejects.toThrow();
  expect(await bounded(session.serverError)).toBe("auth_changed");
});

test("T56: a failed method journal leaves the previous read deadline in force", async () => {
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  const clock = new TestClock();
  devices.useClock(clock);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const closedAt: number[] = [];
  devices.onRevoke(pc.device.id, () => closedAt.push(clock.now()));
  clock.advance(STALE_READ_MS - 1);
  const page = accountMailbox.snapshotPage.bind(accountMailbox);
  spyOn(accountMailbox, "snapshotPage").mockImplementation(async (...args) => {
    const result = await page(...args);
    if (!("page" in result)) return result;
    const parsed = parseSnapshotPage(result.page);
    return { page: { ...parsed, methods_version: parsed.methods_version + 1 } };
  });
  const fault = spyOn(DeviceJournal.prototype, "append").mockImplementationOnce(() => { throw new Error("journal unavailable"); });
  closes.push(() => fault.mockRestore());
  expect(await accountMailbox.readSnapshot()).toBeNull();
  expect(fault.mock.calls[0]?.[0].kind).toBe("method");
  clock.advance(1);
  expect(closedAt).toEqual([STALE_READ_MS]);
});
