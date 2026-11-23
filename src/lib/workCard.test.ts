import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { PlanStep, PlanSummary } from "../../shared/protocol.ts";
import { currentStepId, foldWorkCard, revealScrollTop, workCardFolded, workCardShown, WORK_CARD_FOLD_KEY } from "./workCard.ts";

const step = (id: string, status: PlanStep["status"]): PlanStep => ({ id, label: `step ${id}`, active: null, status, blocked_by: [], owner: null, started_at: null, ended_at: null });
const summary: PlanSummary = { done: 1, total: 3, current: "step 2" };

describe("workCardShown", () => {
  it("is drawn for a plan or a running background task, and for nothing else", () => {
    expect(workCardShown(summary, 0)).toBe(true);
    expect(workCardShown(null, 2)).toBe(true);
    expect(workCardShown(summary, 2)).toBe(true);
    expect(workCardShown(null, 0)).toBe(false);
  });

  it("keeps a plan whose steps are all done: the chip keeps it too", () => {
    expect(workCardShown({ done: 3, total: 3, current: null }, 0)).toBe(true);
  });
});

describe("currentStepId", () => {
  it("is the step in progress, else the next one waiting", () => {
    expect(currentStepId([step("a", "completed"), step("b", "in_progress"), step("c", "pending")])).toBe("b");
    expect(currentStepId([step("a", "completed"), step("b", "pending"), step("c", "pending")])).toBe("b");
    expect(currentStepId([step("a", "pending"), step("b", "in_progress")])).toBe("b");
  });

  it("is none once every step is done, or when there are no steps", () => {
    expect(currentStepId([step("a", "completed"), step("b", "completed")])).toBeNull();
    expect(currentStepId([])).toBeNull();
  });
});

describe("revealScrollTop", () => {
  const view = (top: number) => ({ top, height: 100 });

  it("leaves a list alone while the row is in view whole", () => {
    expect(revealScrollTop(view(0), { top: 0, height: 20 })).toBeNull();
    expect(revealScrollTop(view(40), { top: 60, height: 20 })).toBeNull();
    expect(revealScrollTop(view(0), { top: 80, height: 20 })).toBeNull();
  });

  it("puts a row below the view in the middle of it", () => {
    expect(revealScrollTop(view(0), { top: 300, height: 20 })).toBe(260);
  });

  it("puts a row above the view in the middle of it, never before the list's start", () => {
    expect(revealScrollTop(view(200), { top: 100, height: 20 })).toBe(60);
    expect(revealScrollTop(view(200), { top: 10, height: 20 })).toBe(0);
  });

  it("brings in a row only partly in view", () => {
    expect(revealScrollTop(view(0), { top: 90, height: 20 })).toBe(50);
  });

  it("lines a row taller than the view up with its top", () => {
    expect(revealScrollTop(view(0), { top: 300, height: 140 })).toBe(300);
  });
});

describe("the fold", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let writes: "ok" | "refused";
  let reads: "ok" | "refused";
  let handlers: Set<(event: Pick<StorageEvent, "key">) => void>;

  beforeEach(() => {
    descriptors.set("window", Object.getOwnPropertyDescriptor(globalThis, "window"));
    records = new Map();
    writes = "ok";
    reads = "ok";
    handlers = new Set();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => { if (reads === "refused") throw new Error("blocked"); return records.get(key) ?? null; },
        setItem: (key: string, value: string) => { if (writes === "refused") throw new Error("full"); records.set(key, value); },
      },
      addEventListener: (type: string, handler: (event: Pick<StorageEvent, "key">) => void) => { if (type === "storage") handlers.add(handler); },
      removeEventListener: (type: string, handler: (event: Pick<StorageEvent, "key">) => void) => { if (type === "storage") handlers.delete(handler); },
    } });
  });

  afterEach(() => {
    foldWorkCard(false);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("starts open, and keeps what the device chose in a key of its own", () => {
    expect(workCardFolded()).toBe(false);
    foldWorkCard(true);
    expect(records.get(WORK_CARD_FOLD_KEY)).toBe("true");
    expect(workCardFolded()).toBe(true);
    foldWorkCard(false);
    expect(records.get(WORK_CARD_FOLD_KEY)).toBe("false");
    expect(workCardFolded()).toBe(false);
  });

  it("reads anything but a stored true as open", () => {
    records.set(WORK_CARD_FOLD_KEY, "\"true\"");
    expect(workCardFolded()).toBe(false);
    records.set(WORK_CARD_FOLD_KEY, "yes");
    expect(workCardFolded()).toBe(false);
  });

  it("is open where storage cannot be read", () => {
    reads = "refused";
    expect(workCardFolded()).toBe(false);
  });

  it("keeps the choice for the session where storage refuses it, until storage answers again", () => {
    writes = "refused";
    foldWorkCard(true);
    expect(workCardFolded()).toBe(true);
    writes = "ok";
    foldWorkCard(false);
    expect(workCardFolded()).toBe(false);
    expect(records.get(WORK_CARD_FOLD_KEY)).toBe("false");
  });
});
