import { describe, expect, it } from "bun:test";

import type { PaneSummaries, PaneSummary } from "../../shared/protocol.ts";
import { SUMMARY_RETRIES, SUMMARY_RETRY_MS, SummaryReads, type SummaryTarget } from "./useInboxSummaries.ts";

/** A read whose answers the test hands out one by one, in the order the reads started. */
function harness(now = 0, subscribed = true) {
  const calls: { machineId: string; paneIds: readonly string[]; resolve(answer: PaneSummaries | null): void; reject(error: Error): void }[] = [];
  const waits: { ms: number; run(): void; cancelled: boolean }[] = [];
  const reads = new SummaryReads(
    (machineId, paneIds) => new Promise((resolve, reject) => { calls.push({ machineId, paneIds, resolve, reject }); }),
    (run, ms) => {
      const wait = { ms, run, cancelled: false };
      waits.push(wait);
      return () => { wait.cancelled = true; };
    },
    () => now,
  );
  let notified = 0;
  if (subscribed) reads.subscribe(() => { notified++; });
  return { reads, calls, waits, notified: () => notified };
}

const target = (key: string, stamp = "1", machineId = "local", working = false): SummaryTarget => ({ key, machineId, paneId: `pane-${key}`, stamp, working });
const said = (text: string, at: string | null = null): PaneSummary => ({ role: "assistant", text, at, asked_at: null });
const answer = (summaries: Record<string, PaneSummary | null>, server_time = "1970-01-01T00:00:00.000Z"): PaneSummaries => ({ server_time, summaries });
const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);
/** past every microtask, so an unhandled rejection has been reported */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("SummaryReads", () => {
  it("asks each PC in batches of at most 24, one request in flight per PC", async () => {
    const { reads, calls } = harness();
    const many = Array.from({ length: 30 }, (_, index) => target(`a${index}`));
    reads.sync([...many, target("b0", "1", "other")]);
    expect(calls.map((call) => [call.machineId, call.paneIds.length])).toEqual([["local", 24], ["other", 1]]);
    reads.sync([...many, target("b0", "1", "other"), target("a30")]);
    expect(calls).toHaveLength(2);
    calls[0]!.resolve(answer(Object.fromEntries(calls[0]!.paneIds.map((id) => [id, said(id)]))));
    await settled();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.machineId).toBe("local");
    expect(calls[2]!.paneIds).toEqual([...many.slice(24).map((t) => t.paneId), "pane-a30"]);
    expect(reads.summaries().get("a0")?.text).toBe("pane-a0");
  });

  it("reads a target again when its stamp changes and replaces its words", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a", "1")]);
    calls[0]!.resolve(answer({ "pane-a": said("First") }));
    await settled();
    reads.sync([target("a", "1")]);
    expect(calls).toHaveLength(1);
    reads.sync([target("a", "2")]);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(answer({ "pane-a": said("Second") }));
    await settled();
    expect(reads.summaries().get("a")?.text).toBe("Second");
  });

  it("asks again after the wait for a pane the answer left out, three times at most", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a"), target("b")]);
    calls[0]!.resolve(answer({ "pane-b": said("here") }));
    await settled();
    expect(reads.summaries().get("b")?.text).toBe("here");
    for (let attempt = 1; attempt <= SUMMARY_RETRIES; attempt++) {
      expect(waits).toHaveLength(attempt);
      expect(waits[attempt - 1]!.ms).toBe(SUMMARY_RETRY_MS);
      waits[attempt - 1]!.run();
      expect(calls).toHaveLength(attempt + 1);
      expect(calls[attempt]!.paneIds).toEqual(["pane-a"]);
      calls[attempt]!.resolve(answer({}));
      await settled();
    }
    expect(waits).toHaveLength(SUMMARY_RETRIES);
    expect(calls).toHaveLength(SUMMARY_RETRIES + 1);
  });

  it("asks the panes an answer left out again with the first of them last, so no pane heads every retry", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a"), target("b"), target("c")]);
    calls[0]!.resolve(answer({}));
    await settled();
    for (const wait of waits) wait.run();
    for (let index = 1; index < calls.length; index++) {
      calls[index]!.resolve(answer({}));
      await settled();
    }
    expect(calls.slice(1, 3).flatMap((call) => call.paneIds)).toEqual(["pane-b", "pane-c", "pane-a"]);
  });

  it("asks a PC that had no route again once a sync held none of its rows (it went away)", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a"), target("x", "1", "other")]);
    calls[0]!.resolve(null);
    await settled();
    reads.sync([target("a", "2"), target("x", "1", "other")]);
    expect(calls.map((call) => call.machineId)).toEqual(["local", "other"]);
    reads.sync([target("x", "1", "other")]);
    reads.sync([target("a", "2"), target("x", "1", "other")]);
    expect(calls.map((call) => call.machineId)).toEqual(["local", "other", "local"]);
  });

  it("counts a summary with a field of the wrong type as none", async () => {
    const { reads, calls } = harness();
    reads.sync(["a", "b", "c", "d", "e", "f"].map((key) => target(key)));
    const wrong = (summary: Record<string, unknown>) => summary as unknown as PaneSummary;
    calls[0]!.resolve(answer({
      "pane-a": wrong({ text: 5 }),
      "pane-b": wrong({ ...said("x"), role: "robot" }),
      "pane-c": wrong({ ...said("x"), at: 5 }),
      "pane-d": wrong({ ...said("x"), asked_at: {} }),
      "pane-e": wrong({ ...said("x"), text: null }),
      "pane-f": said("fine"),
    }));
    await settled();
    expect([...reads.summaries().keys()]).toEqual(["f"]);
  });

  it("asks a working row once more after the wait when its new stamp answers with the words and time it had", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a", "1", "local", true)]);
    calls[0]!.resolve(answer({ "pane-a": said("Last turn", "1970-01-01T00:00:01.000Z") }));
    await settled();
    expect(waits).toHaveLength(0);
    reads.sync([target("a", "2", "local", true)]);
    calls[1]!.resolve(answer({ "pane-a": said("Last turn", "1970-01-01T00:00:01.000Z") }));
    await settled();
    expect(waits.map((wait) => wait.ms)).toEqual([SUMMARY_RETRY_MS]);
    waits[0]!.run();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.paneIds).toEqual(["pane-a"]);
    calls[2]!.resolve(answer({ "pane-a": said("Last turn", "1970-01-01T00:00:01.000Z") }));
    await settled();
    expect(waits).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("asks no row again for the same words when it is not working or its words changed", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a"), target("b", "1", "local", true)]);
    calls[0]!.resolve(answer({ "pane-a": said("Same"), "pane-b": said("Old") }));
    await settled();
    reads.sync([target("a", "2"), target("b", "2", "local", true)]);
    calls[1]!.resolve(answer({ "pane-a": said("Same"), "pane-b": said("New") }));
    await settled();
    expect(waits).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });

  it("asks a PC that has no route only once", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a")]);
    calls[0]!.resolve(null);
    await settled();
    reads.sync([target("a", "2"), target("b")]);
    expect(calls).toHaveLength(1);
    reads.sync([target("a", "2"), target("b"), target("c", "1", "other")]);
    expect(calls.map((call) => call.machineId)).toEqual(["local", "other"]);
  });

  it("drops an answer for a target that left, and its summary with it", async () => {
    const { reads, calls, notified } = harness();
    reads.sync([target("a"), target("b")]);
    reads.sync([target("b")]);
    calls[0]!.resolve(answer({ "pane-a": said("gone"), "pane-b": said("kept") }));
    await settled();
    expect([...reads.summaries().keys()]).toEqual(["b"]);
    reads.sync([]);
    expect(reads.summaries().size).toBe(0);
    expect(notified()).toBe(2);
  });

  it("drops an answer for a stamp that moved on while it was in flight, then reads the new stamp", async () => {
    const { reads, calls, notified } = harness();
    reads.sync([target("a", "1")]);
    reads.sync([target("a", "2")]);
    expect(calls).toHaveLength(1);
    const before = reads.summaries();
    calls[0]!.resolve(answer({ "pane-a": said("Old") }));
    await settled();
    expect(reads.summaries()).toBe(before);
    expect(notified()).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.paneIds).toEqual(["pane-a"]);
    calls[1]!.resolve(answer({ "pane-a": said("New") }));
    await settled();
    expect(reads.summaries().get("a")?.text).toBe("New");
    expect(notified()).toBe(1);
  });

  it("cancels a waiting retry when its stamp moves on or its key leaves", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a"), target("b")]);
    calls[0]!.resolve(answer({}));
    await settled();
    expect(waits.map((wait) => wait.cancelled)).toEqual([false, false]);
    reads.sync([target("a", "2")]);
    expect(waits.map((wait) => wait.cancelled)).toEqual([true, true]);
  });

  it("takes the server's clock offset out of at and askedAt", async () => {
    const deviceNow = Date.parse("2026-11-12T10:00:00.000Z");
    const { reads, calls } = harness(deviceNow);
    reads.sync([target("a"), target("b")]);
    calls[0]!.resolve(answer({
      "pane-a": { ...said("ok", "2026-11-12T10:04:00.000Z"), asked_at: "2026-11-12T10:01:00.000Z" },
      "pane-b": said("never asked", "2026-11-12T10:03:00.000Z"),
    }, "2026-11-12T10:05:00.000Z"));
    await settled();
    expect(reads.summaries().get("a")).toEqual({
      role: "assistant", text: "ok", failed: false,
      at: Date.parse("2026-11-12T09:59:00.000Z"), askedAt: Date.parse("2026-11-12T09:56:00.000Z"),
    });
    expect(reads.summaries().get("b")).toEqual({ role: "assistant", text: "never asked", failed: false, at: Date.parse("2026-11-12T09:58:00.000Z"), askedAt: null });
  });

  it("keeps failed: true from the wire, and false when the wire says nothing", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a"), target("b")]);
    calls[0]!.resolve(answer({ "pane-a": { ...said("Deploy failed"), failed: true }, "pane-b": said("Done") }));
    await settled();
    expect(reads.summaries().get("a")?.failed).toBe(true);
    expect(reads.summaries().get("b")?.failed).toBe(false);
  });

  it("replaces kept words and notifies once when only failed or askedAt changes", async () => {
    const { reads, calls, notified } = harness();
    reads.sync([target("a", "1")]);
    calls[0]!.resolve(answer({ "pane-a": said("Same") }));
    await settled();
    expect(notified()).toBe(1);
    reads.sync([target("a", "2")]);
    calls[1]!.resolve(answer({ "pane-a": said("Same") }));
    await settled();
    expect(notified()).toBe(1);
    reads.sync([target("a", "3")]);
    calls[2]!.resolve(answer({ "pane-a": { ...said("Same"), failed: true } }));
    await settled();
    expect(notified()).toBe(2);
    expect(reads.summaries().get("a")?.failed).toBe(true);
    // the words carried to the new stamp lose their failed mark at once, and the answer gives it back with its askedAt
    reads.sync([target("a", "4")]);
    expect(notified()).toBe(3);
    expect(reads.summaries().get("a")?.failed).toBe(false);
    calls[3]!.resolve(answer({ "pane-a": { ...said("Same"), failed: true, asked_at: "1970-01-01T00:00:01.000Z" } }));
    await settled();
    expect(notified()).toBe(4);
    expect(reads.summaries().get("a")?.failed).toBe(true);
    expect(reads.summaries().get("a")?.askedAt).toBe(1000);
  });

  it("carries a row's words to its new stamp without their failed mark, which holds only for the state it was answered for", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a", "1")]);
    calls[0]!.resolve(answer({ "pane-a": { ...said("Error: rate limited"), failed: true } }));
    await settled();
    expect(reads.summaries().get("a")?.failed).toBe(true);
    reads.sync([target("a", "2")]);
    expect(reads.summaries().get("a")).toMatchObject({ text: "Error: rate limited", failed: false });
    calls[1]!.resolve(answer({ "pane-a": { ...said("Error: rate limited"), failed: true } }));
    await settled();
    expect(reads.summaries().get("a")?.failed).toBe(true);
  });

  it("keeps the old words after a stamp change until the new read settles", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a", "1")]);
    calls[0]!.resolve(answer({ "pane-a": said("First") }));
    await settled();
    reads.sync([target("a", "2")]);
    expect(reads.summaries().get("a")?.text).toBe("First");
    calls[1]!.resolve(answer({ "pane-a": said("Second") }));
    await settled();
    expect(reads.summaries().get("a")?.text).toBe("Second");
    reads.sync([target("a", "3")]);
    expect(reads.summaries().get("a")?.text).toBe("Second");
    calls[2]!.resolve(answer({ "pane-a": null }));
    await settled();
    expect(reads.summaries().has("a")).toBe(false);
  });

  it("asks a failed request again after the wait, three times at most", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a")]);
    calls[0]!.reject(new Error("offline"));
    await settled();
    for (let attempt = 1; attempt <= SUMMARY_RETRIES; attempt++) {
      expect(waits).toHaveLength(attempt);
      expect(waits[attempt - 1]!.ms).toBe(SUMMARY_RETRY_MS);
      waits[attempt - 1]!.run();
      expect(calls).toHaveLength(attempt + 1);
      expect(calls[attempt]!.paneIds).toEqual(["pane-a"]);
      calls[attempt]!.reject(new Error("offline"));
      await settled();
    }
    expect(waits).toHaveLength(SUMMARY_RETRIES);
    expect(calls).toHaveLength(SUMMARY_RETRIES + 1);
    reads.sync([target("a")]);
    expect(calls).toHaveLength(SUMMARY_RETRIES + 1);
  });

  it("removes the words of an earlier stamp once the new read has used its retries", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a", "1")]);
    calls[0]!.resolve(answer({ "pane-a": said("First") }));
    await settled();
    reads.sync([target("a", "2")]);
    calls[1]!.reject(new Error("offline"));
    await settled();
    for (let attempt = 1; attempt <= SUMMARY_RETRIES; attempt++) {
      expect(reads.summaries().get("a")?.text).toBe("First");
      waits[attempt - 1]!.run();
      if (attempt % 2 === 1) calls[attempt + 1]!.reject(new Error("offline")); else calls[attempt + 1]!.resolve(answer({}));
      await settled();
    }
    expect(calls).toHaveLength(SUMMARY_RETRIES + 2);
    expect(reads.summaries().has("a")).toBe(false);
  });

  it("removes the words of an earlier stamp once a pane left out of every answer has used its retries", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a", "1")]);
    calls[0]!.resolve(answer({ "pane-a": said("First") }));
    await settled();
    reads.sync([target("a", "2")]);
    calls[1]!.resolve(answer({}));
    await settled();
    for (let attempt = 1; attempt <= SUMMARY_RETRIES; attempt++) {
      expect(reads.summaries().get("a")?.text).toBe("First");
      waits[attempt - 1]!.run();
      calls[attempt + 1]!.resolve(answer({}));
      await settled();
    }
    expect(waits).toHaveLength(SUMMARY_RETRIES);
    expect(calls).toHaveLength(SUMMARY_RETRIES + 2);
    expect(reads.summaries().has("a")).toBe(false);
  });

  it("releases the PC and retries the batch when taking an answer throws, leaving no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const hear = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", hear);
    try {
      const { reads, calls, waits } = harness();
      reads.sync([target("a")]);
      reads.sync([target("a"), target("b")]);
      calls[0]!.resolve({ server_time: "1970-01-01T00:00:00.000Z" } as PaneSummaries);
      await settled();
      await tick();
      expect(calls.map((call) => call.paneIds)).toEqual([["pane-a"], ["pane-b"]]);
      expect(waits.map((wait) => wait.ms)).toEqual([SUMMARY_RETRY_MS]);
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", hear); }
  });

  it("keeps an answer taken with no subscriber, and starts no read for the same targets again", async () => {
    const { reads, calls } = harness(0, false);
    reads.sync([target("a")]);
    calls[0]!.resolve(answer({ "pane-a": said("while away") }));
    await settled();
    expect(reads.summaries().get("a")?.text).toBe("while away");
    let notified = 0;
    const unsubscribe = reads.subscribe(() => { notified++; });
    reads.sync([target("a")]);
    expect(calls).toHaveLength(1);
    expect(notified).toBe(0);
    expect(reads.summaries().get("a")?.text).toBe("while away");
    unsubscribe();
  });
});
