import { afterEach, expect, spyOn, test } from "bun:test";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { bounded, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { createListedPc } from "./listed-pc.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { STALE_READ_MS } from "./account-devices.ts";
import { ask } from "./pairing.test-helpers.ts";

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
