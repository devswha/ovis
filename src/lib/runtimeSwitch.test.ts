import { expect, it } from "bun:test";
import { followRestart } from "./runtimeSwitch.ts";

/** a clock and a queue the test advances by hand: no real timer runs */
function manual(answers: (string | null | Error)[]) {
  let time = 0;
  const queued: { run: () => void; ms: number }[] = [];
  const outcome = { back: 0, lost: 0, asked: 0 };
  const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });
  const options = {
    boot: async () => {
      const answer = answers[Math.min(outcome.asked++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onBack: () => { outcome.back += 1; },
    onLost: () => { outcome.lost += 1; },
    now: () => time,
    schedule: (run: () => void, ms: number) => { queued.push({ run, ms }); },
    pollMs: 1000,
    waitMs: 5000,
  };
  const tick = async () => {
    await settle();
    const next = queued.shift();
    if (!next) return false;
    time += next.ms;
    next.run();
    await settle();
    return true;
  };
  return { options, outcome, tick };
}

it("waits through the outage for another boot id, then tells the app once", async () => {
  const { options, outcome, tick } = manual(["old", null, new Error("down"), "new"]);
  followRestart({ ...options, from: "old" });
  while (await tick());
  expect(outcome).toEqual({ back: 1, lost: 0, asked: 4 });
});

it("gives up once the deadline passes with no other server, and asks no more", async () => {
  const { options, outcome, tick } = manual(["old"]);
  followRestart({ ...options, from: "old" });
  while (await tick());
  expect(outcome.back).toBe(0);
  expect(outcome.lost).toBe(1);
  expect(outcome.asked).toBe(7);
});
