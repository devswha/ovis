import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeNotice, readNoticesSeen, writeNoticesSeen, type ListNewcomer } from "./listNotices.ts";

describe("what the device notices have shown", () => {
  let descriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const kept = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } } });
  });
  afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("keeps a record per account and list, and reads none for another list", () => {
    writeNoticesSeen("acct_a", { list: "aa".repeat(32), floor: 3, closed: ["k"] });
    writeNoticesSeen("acct_b", { list: "bb".repeat(32), floor: 1, closed: [] });
    expect(readNoticesSeen("acct_a", "aa".repeat(32))).toEqual({ list: "aa".repeat(32), floor: 3, closed: ["k"] });
    expect(readNoticesSeen("acct_a", "cc".repeat(32))).toBeNull();
    expect(readNoticesSeen("acct_c", "aa".repeat(32))).toBeNull();
  });

  it("moves its floor up once every notice shown is closed, and keeps the closed ones until then", () => {
    const shown: ListNewcomer[] = [{ key: "k1", seq: 4, by: "a" }, { key: "k2", seq: 6, by: "a" }];
    const one = closeNotice({ list: "l", floor: 2, closed: [] }, shown, "k2");
    expect(one).toEqual({ list: "l", floor: 2, closed: ["k2"] });
    expect(closeNotice(one, shown, "k1")).toEqual({ list: "l", floor: 6, closed: [] });
  });
});
