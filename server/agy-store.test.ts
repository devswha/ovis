import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAgyProcessName,
  resetWindowsScanCacheForTest,
  type RestartManagerApi,
  windowsHeldPaths,
  windowsHolders,
  windowsLockCandidates,
} from "./agy-store.ts";

it("reads only presence locks as candidates, never another file beside them", () => {
  const root = mkdtempSync(join(tmpdir(), "agy-store-"));
  mkdirSync(join(root, "presence"));
  const lock = "00000000-0000-4000-8000-000000000001.lock";
  writeFileSync(join(root, "presence", lock), "");
  writeFileSync(join(root, "presence", "state.json"), "{}");
  writeFileSync(join(root, "presence", "notes.lock"), "");
  expect(windowsLockCandidates({ ANTIGRAVITY_APP_DATA_DIR: root }, root)).toEqual([join(root, "presence", lock)]);
});

it("names no candidate when the agent keeps no presence directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agy-store-"));
  expect(windowsLockCandidates({ ANTIGRAVITY_APP_DATA_DIR: root }, root)).toEqual([]);
});

it("recognizes the agent's process name as herdr reports it on this platform", () => {
  const win32 = process.platform === "win32";
  expect(isAgyProcessName(win32 ? "agy.exe" : "agy")).toBe(true);
  expect(isAgyProcessName("agy")).toBe(true);
  expect(isAgyProcessName("agyx")).toBe(false);
  expect(isAgyProcessName("bun")).toBe(false);
  expect(isAgyProcessName(undefined)).toBe(false);
  expect(isAgyProcessName("/usr/local/bin/agy")).toBe(win32);
});

it("updates held lock when the process switches from lock A to lock B on /new or /resume", async () => {
  resetWindowsScanCacheForTest();
  const pid = 4242;
  const lockA = "C:\\path\\presence\\00000000-0000-4000-8000-000000000001.lock";
  const lockB = "C:\\path\\presence\\00000000-0000-4000-8000-000000000002.lock";
  let activeHolders: Record<string, number[]> = { [lockA]: [pid], [lockB]: [] };
  const mockHolders = (path: string) => activeHolders[path] ?? [];
  const mockCandidates = () => [lockA, lockB];

  expect(await windowsHeldPaths(pid, mockHolders, mockCandidates)).toEqual([lockA]);

  activeHolders = { [lockA]: [], [lockB]: [pid] };

  expect(await windowsHeldPaths(pid, mockHolders, mockCandidates)).toEqual([lockB]);
});

it("drops held lock when the process releases its session lock without acquiring another", async () => {
  resetWindowsScanCacheForTest();
  const pid = 4242;
  const lockA = "C:\\path\\presence\\00000000-0000-4000-8000-000000000001.lock";
  let activeHolders: Record<string, number[]> = { [lockA]: [pid] };
  const mockHolders = (path: string) => activeHolders[path] ?? [];
  const mockCandidates = () => [lockA];

  expect(await windowsHeldPaths(pid, mockHolders, mockCandidates)).toEqual([lockA]);

  activeHolders = { [lockA]: [] };

  expect(await windowsHeldPaths(pid, mockHolders, mockCandidates)).toEqual([]);
});

it("coalesces concurrent scans across panes without invalidating scan cache", async () => {
  resetWindowsScanCacheForTest();
  const pid1 = 4242;
  const pid2 = 4243;
  const lock1 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000001.lock";
  const lock2 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000002.lock";
  const activeHolders: Record<string, number[]> = { [lock1]: [pid1], [lock2]: [pid2] };
  const mockHolders = (path: string) => activeHolders[path] ?? [];
  let candidateCalls = 0;
  const mockCandidates = () => {
    candidateCalls += 1;
    return [lock1, lock2];
  };

  const [res1, res2] = await Promise.all([
    windowsHeldPaths(pid1, mockHolders, mockCandidates),
    windowsHeldPaths(pid2, mockHolders, mockCandidates),
  ]);

  expect(res1).toEqual([lock1]);
  expect(res2).toEqual([lock2]);
  expect(candidateCalls).toBe(1);
  expect(await windowsHeldPaths(pid1, mockHolders, mockCandidates)).toEqual([lock1]);
  expect(candidateCalls).toBe(1);
});

it("discovers a newly held lock after overlapping callers when TTL expires", async () => {
  resetWindowsScanCacheForTest();
  const pid1 = 4242;
  const pid2 = 4243;
  const pid3 = 4244;
  const lock1 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000001.lock";
  const lock2 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000002.lock";
  const lock3 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000003.lock";
  let activeHolders: Record<string, number[]> = { [lock1]: [pid1], [lock2]: [pid2], [lock3]: [] };
  const mockHolders = (path: string) => activeHolders[path] ?? [];
  let candidateCalls = 0;
  const mockCandidates = () => {
    candidateCalls += 1;
    return [lock1, lock2, lock3];
  };

  const [res1, res2] = await Promise.all([
    windowsHeldPaths(pid1, mockHolders, mockCandidates),
    windowsHeldPaths(pid2, mockHolders, mockCandidates),
  ]);

  expect(res1).toEqual([lock1]);
  expect(res2).toEqual([lock2]);
  expect(candidateCalls).toBe(1);

  // New lock acquired by pid3:
  activeHolders = { [lock1]: [pid1], [lock2]: [pid2], [lock3]: [pid3] };

  // At +6 seconds, TTL expires: a new scan must run and discover lock3
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6_000;
    expect(await windowsHeldPaths(pid3, mockHolders, mockCandidates)).toEqual([lock3]);
    expect(candidateCalls).toBe(2);
  } finally {
    Date.now = realNow;
  }
});

it("retries and reallocates when RmGetList returns ERROR_MORE_DATA (234) with growing needed", () => {
  let callIndex = 0;
  const mockApi: RestartManagerApi = {
    symbols: {
      RmStartSession: (session: Buffer) => {
        session.writeUInt32LE(1234, 0);
        return 0;
      },
      RmRegisterResources: () => 0,
      RmGetList: (_handle: number, needed: Buffer, count: Buffer, list: Buffer | null) => {
        callIndex += 1;
        if (callIndex === 1) {
          needed.writeUInt32LE(1, 0);
          return 234;
        }
        if (callIndex === 2) {
          needed.writeUInt32LE(2, 0);
          return 234;
        }
        if (callIndex === 3) {
          needed.writeUInt32LE(2, 0);
          count.writeUInt32LE(2, 0);
          if (list) {
            list.writeUInt32LE(4242, 0);
            list.writeUInt32LE(4243, 668);
          }
          return 0;
        }
        return 0;
      },
      RmEndSession: () => 0,
    },
  };

  const holders = windowsHolders("C:\\path\\presence\\test.lock", mockApi);
  expect(holders).toEqual([4242, 4243]);
  expect(callIndex).toBe(3);
});
