import { expect, it } from "bun:test";
import { awaitRestart, followRestart, restartState } from "./runtimeSwitch.ts";

/** a clock and a queue the test advances by hand: no real timer runs */
type Answer = { id: string; ready: boolean } | null | Error | "never";
const up = (id: string) => ({ id, ready: true });
function manual(answers: Answer[]) {
  let time = 0;
  const queued: { run: () => void; ms: number }[] = [];
  // an ask's bound runs only when nothing else is left: the asks that answer never need it
  const bounds: { run: () => void; ms: number }[] = [];
  const outcome = { back: 0, lost: 0, asked: 0 };
  const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });
  const options = {
    boot: async () => {
      const answer = answers[Math.min(outcome.asked++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      if (answer === "never") return new Promise<{ id: string; ready: boolean } | null>(() => {});
      return answer;
    },
    onBack: () => { outcome.back += 1; },
    onLost: () => { outcome.lost += 1; },
    now: () => time,
    schedule: (run: () => void, ms: number) => { queued.push({ run, ms }); },
    limit: (ms: number) => new Promise<null>((resolve) => { bounds.push({ run: () => resolve(null), ms }); }),
    pollMs: 1000,
    waitMs: 5000,
  };
  const tick = async () => {
    await settle();
    const next = queued.shift() ?? bounds.shift();
    if (!next) return false;
    time += next.ms;
    next.run();
    await settle();
    return true;
  };
  return { options, outcome, tick };
}

it("waits through the outage for another boot id, then tells the app once", async () => {
  const { options, outcome, tick } = manual([up("old"), null, new Error("down"), up("new")]);
  followRestart({ ...options, from: "old" });
  while (await tick());
  expect(outcome).toEqual({ back: 1, lost: 0, asked: 4 });
});

it("gives up once the deadline passes with no other server, and asks no more", async () => {
  const { options, outcome, tick } = manual([up("old")]);
  followRestart({ ...options, from: "old" });
  while (await tick());
  expect(outcome.back).toBe(0);
  expect(outcome.lost).toBe(1);
  expect(outcome.asked).toBe(7);
});

it("bounds an ask that never settles, so the deadline still comes", async () => {
  const { options, outcome, tick } = manual(["never"]);
  followRestart({ ...options, from: "old", askMs: 2000 });
  while (await tick());
  expect(outcome.back).toBe(0);
  expect(outcome.lost).toBe(1);
});

it("keeps the switch's state for the page, past whatever shows it, until the server is back or lost", async () => {
  const back = manual([null, up("new")]);
  let told = 0;
  awaitRestart("herdr-core", { ...back.options, from: "old", onBack: () => { told += 1; } });
  expect(restartState()).toEqual({ to: "herdr-core", lost: false });
  while (await back.tick());
  expect(restartState()).toBeNull();
  expect(told).toBe(1);
  const away = manual([up("old")]);
  awaitRestart("herdr", { ...away.options, from: "old", onBack: () => {} });
  while (await away.tick());
  expect(restartState()).toEqual({ to: "herdr", lost: true });
});

it("waits out a new bridge whose runtime does not answer yet: the launcher may still roll it back", async () => {
  // a herdr-core start still in its check, then the bridge the rollback started, which answers whole
  const { options, outcome, tick } = manual([{ id: "candidate", ready: false }, { id: "candidate", ready: false }, up("restored")]);
  followRestart({ ...options, from: "old", settleMs: 25_000, waitMs: 90_000 });
  while (await tick());
  expect(outcome).toMatchObject({ back: 1, asked: 3 });
});

it("takes a new bridge whose runtime is rightly away once it outlasted the launcher's check", async () => {
  // a switch to a herdr TUI that is stopped: the bridge stays, the whole health answer never comes
  const { options, outcome, tick } = manual([{ id: "new", ready: false }]);
  followRestart({ ...options, from: "old", settleMs: 3000, waitMs: 90_000 });
  while (await tick());
  expect(outcome.back).toBe(1);
  expect(outcome.lost).toBe(0);
  expect(outcome.asked).toBe(4);
});
