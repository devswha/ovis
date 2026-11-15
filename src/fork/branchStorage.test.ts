import { afterEach, expect, it } from "bun:test";
import { WorkspaceBranchCache } from "../lib/worktreeBranches.ts";
import { restoreForkBranches, saveForkBranches } from "./branchStorage.ts";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

it("does not read or change branch storage with the fork header off", () => {
  let calls = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => { calls++; }, setItem: () => { calls++; } } });
  const cache = new WorkspaceBranchCache();
  restoreForkBranches(cache, "local", false);
  saveForkBranches(cache, "local", false);
  expect(calls).toBe(0);
});

it("keeps cold-start branches on this PC when the fork header is on", () => {
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
  const cache = new WorkspaceBranchCache();
  saveForkBranches(cache, "local", true);
  expect(JSON.parse(stored.get("ovis:branches:local")!)).toEqual(cache.saved());
  restoreForkBranches(new WorkspaceBranchCache(), "local", true);
  expect(stored.has("ovis:branches:build")).toBe(false);
});
