import { describe, expect, test } from "bun:test";
import type { AdmissionOrigin } from "../../shared/account-snapshot.ts";
import { CatchUpGate, type GatedRow } from "./catch-up-gate.ts";

const at = "2026-11-20T05:00:00.000Z";
const origin = (from: AdmissionOrigin["from"], how: AdmissionOrigin["how"]): AdmissionOrigin => ({ from, how, by: null, admit_no: from === "legacy" ? 0 : 1, at });
const rows: Record<string, GatedRow> = {
  code: { id: "a".repeat(16), origin: origin("pc", "code") },
  digits: { id: "b".repeat(16), origin: origin("pc", "digits") },
  qr: { id: "c".repeat(16), origin: origin("pc", "qr") },
  confirmed: { id: "d".repeat(16), origin: origin("pc", "confirmed") },
  linked: { id: "e".repeat(16), origin: origin("remote", "link") },
  member: { id: "f".repeat(16), origin: origin("remote", "member") },
  recover: { id: "1".repeat(16), origin: origin("recover", "qr") },
  legacy: { id: "2".repeat(16), origin: origin("legacy", "legacy") },
  bare: { id: "3".repeat(16), origin: undefined },
};
const rowOf = (id: string) => Object.values(rows).find((row) => row.id === id);
const waiting = (gate: CatchUpGate) => Object.entries(rows).filter(([, row]) => gate.waits(row)).map(([name]) => name);

describe("S2-27 devices.json rows wait for the first whole read (T41, T42, T65, T70)", () => {
  test("T41: every non-screen-paired row waits after restart or first binding, including legacy with no metadata", () => {
    let bound = true;
    const gate = new CatchUpGate(() => bound);
    expect(waiting(gate)).toEqual(["confirmed", "linked", "member", "recover", "legacy", "bare"]);
    gate.wholeRead();
    expect(waiting(gate)).toEqual([]);
    gate.bound();
    expect(waiting(gate)).toEqual(["confirmed", "linked", "member", "recover", "legacy", "bare"]);
    bound = false;
    expect(waiting(new CatchUpGate(() => bound))).toEqual([]);
  });

  test("T65: with the service off no read comes, so the wait stays; only screen-paired rows and named releases get in", () => {
    const gate = new CatchUpGate(() => true);
    expect(gate.release([rows.legacy!.id], rowOf)).toEqual([rows.legacy!.id]);
    expect(waiting(gate)).toEqual(["confirmed", "linked", "member", "recover", "bare"]);
  });

  test("T70: release names only rows that wait, lasts until the next whole read, and a restart forgets it", () => {
    const gate = new CatchUpGate(() => true);
    expect(gate.release([rows.member!.id, rows.code!.id, "9".repeat(16)], rowOf)).toEqual([rows.member!.id]);
    expect(gate.waits(rows.member!)).toBe(false);
    gate.wholeRead();
    gate.bound();
    expect(gate.waits(rows.member!)).toBe(true);
    expect(new CatchUpGate(() => true).waits(rows.member!)).toBe(true);
  });

  test("T42: a whole read ends the wait only for the rows its guard passes", () => {
    const gate = new CatchUpGate(() => true);
    gate.wholeRead((row) => row.id !== rows.linked!.id);
    expect(waiting(gate)).toEqual(["linked"]);
  });
});
