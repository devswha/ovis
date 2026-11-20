import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { bounded, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { createListedPc } from "./listed-pc.test-helpers.ts";
import { ask } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function pc() {
  const clock = new TestClock();
  clock.advance(Date.UTC(2026, 0, 1, 12));
  const time = spyOn(Date, "now").mockImplementation(() => clock.now());
  closes.push(() => time.mockRestore());
  const listed = await createListedPc(close => closes.push(close));
  const row = () => {
    const found = parseAccountDevicesFile(JSON.parse(readFileSync(join(listed.fixture.stateDir, ACCOUNT_DEVICES_FILE), "utf8")))
      .devices.find(candidate => candidate.id === listed.device.id);
    if (!found) throw new Error("Missing listed row");
    return found;
  };
  clock.advance(10_000);
  const link = await relayConnection(listed.fixture, { serverId: listed.serverId });
  expect((await link.auth(listed.device, [ACCOUNT_OPENS_ALL_FEATURE])).role).toBe("drive");
  return { ...listed, clock, row, link };
}

test("P9/T54: an idle session cannot refresh its day while whole reads fail", async () => {
  const machine = await pc();
  const { accountMailbox } = machine.fixture.app.context.services;
  const lastDay = machine.row().last_signin_day;
  machine.clock.advance(60 * 86_400_000);
  machine.service.opensAll = false;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: false, reason: "page_failed" });

  const outcome = await bounded(Promise.race([
    ask(machine.link, "/api/devices").then(answer => answer.status, () => machine.link.serverError),
    machine.link.serverError,
  ]));
  expect(outcome).toBe("auth_changed");
  expect(machine.row()).toMatchObject({ state: "expired", last_signin_day: lastDay });
  machine.service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(machine.row()).toMatchObject({ state: "expired", last_signin_day: lastDay });
});

test("P9/T54: a proved sign-in refuses an idle admission when the service is down", async () => {
  const machine = await pc();
  const lastDay = machine.row().last_signin_day;
  machine.clock.advance(60 * 86_400_000);
  machine.service.opensAll = false;
  const returning = await relayConnection(machine.fixture, { serverId: machine.serverId });
  const result = await bounded(Promise.race([
    returning.auth(machine.device, [ACCOUNT_OPENS_ALL_FEATURE]).then(() => "authenticated", () => returning.serverError),
    returning.serverError,
  ]));
  expect(result).toBe("not_listed");
  expect(machine.row()).toMatchObject({ state: "expired", last_signin_day: lastDay });
  expect(await bounded(machine.link.serverError)).toBe("auth_changed");
});
