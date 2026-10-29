import { afterEach, expect, it } from "bun:test";
import { loadRelayIdentity } from "./identity.ts";
import { RelayLink } from "./link.ts";
import { relayFixture, TestClock } from "./test-helpers.ts";

const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

it("reconnects linearly from one to thirty seconds with twenty percent jitter and cancels on stop", async () => {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const clock = new TestClock();
  const attempts: number[] = [];
  let random = 0;
  const link = new RelayLink({
    relay: "wss://relay.example", identity: loadRelayIdentity(fixture.stateDir),
    services: fixture.app.context.services, port: fixture.app.port, clock, random: () => random,
    connect: () => { attempts.push(clock.now()); throw new Error("Network unavailable"); },
    onState: () => {},
  });
  link.start();
  expect(attempts).toEqual([0]);
  for (let attempt = 1; attempt <= 35; attempt++) {
    const delay = Math.min(attempt, 30) * 1000 * (random === 0 ? 0.8 : 1.2);
    clock.advance(delay - 1);
    expect(attempts).toHaveLength(attempt);
    random = random === 0 ? 1 : 0;
    clock.advance(1);
    expect(attempts).toHaveLength(attempt + 1);
  }
  await link.stop();
  clock.advance(60_000);
  expect(attempts).toHaveLength(36);
  expect(clock.tasks.size).toBe(0);
});
