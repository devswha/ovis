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
  const time = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
  closes.push(() => time.mockRestore());
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  devices.useClock(clock);
  // Refresh through the real mailbox with the PC clock installed, not by supplying staleness to the row store.
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  clock.advance(JOIN_HOLD_MS);
  const session = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await session.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(session, "/api/account/status")).status).toBe(200);
  const errors: string[] = [];
  session.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) errors.push(frame.payload.code); };
  pc.service.opensAll = false;

  clock.advance(STALE_READ_MS - 1);
  await accountMailbox.pull();
  expect((await ask(session, "/api/account/status")).status).toBe(200);
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
