/**
 * The one guard of a locked PC (device-row-states rows P11, S24, N1-N7, R7, T46, and the hub's S19 ruling): while the
 * log holds a lock, a request gets in only as a row admitted at this PC's screen or as PC-local; while the log cannot be
 * read (strict, stricter than locked) only PC-local gets in.
 */
import { expect, test } from "bun:test";
import type { Access } from "./access.ts";
import { lockBoundary, type LockScope } from "./lock-boundary.ts";

const open: LockScope = { locked: false, strict: false };
const locked: LockScope = { locked: true, strict: false };
const strict: LockScope = { locked: false, strict: true };

const row = (from: string | null): Access => ({ level: "full", via: "device", role: "drive", device: { id: "d1", role: "drive", label: "Phone", origin: from === null ? null : { from, how: "code" } } as never });
const relayRow = (from: string | null): Access => ({ ...row(from), via: "relay" } as Access);
const grant = (via: "token" | "portal" | "tailscale" | "open" | "local"): Access => ({ level: "full", via, role: "drive" });

test("T46: an unlocked PC lets every grant through as before", () => {
  for (const access of [grant("token"), grant("portal"), grant("tailscale"), grant("open"), grant("local"), row("remote"), row(null)]) {
    expect(lockBoundary(access, open, { localProof: false })).toBe(access);
  }
});

test("T46: while locked, the access token, Portal, a Tailscale login and the open LAN do not count", () => {
  for (const via of ["token", "portal", "tailscale", "open"] as const) {
    expect(lockBoundary(grant(via), locked, { localProof: true })).toEqual({ level: "none", reason: "locked" });
  }
});

test("N4: while locked, a loopback window drives only with local proof from this PC's screen", () => {
  expect(lockBoundary(grant("local"), locked, { localProof: false })).toEqual({ level: "none", reason: "locked" });
  expect(lockBoundary(grant("local"), locked, { localProof: true })).toEqual(grant("local"));
});

test("P11: while locked, only a row admitted at this PC's screen gets in, directly or through the relay", () => {
  expect(lockBoundary(row("pc"), locked, { localProof: false })).toEqual(row("pc"));
  expect(lockBoundary(relayRow("pc"), locked, { localProof: false })).toEqual(relayRow("pc"));
  for (const from of ["remote", "recover", "legacy", null]) {
    expect(lockBoundary(row(from), locked, { localProof: false })).toEqual({ level: "none", reason: "locked" });
    expect(lockBoundary(relayRow(from), locked, { localProof: false })).toEqual({ level: "none", reason: "locked" });
  }
});

test("S19: strict counts as locked-and-closed for every grant that is not a row", () => {
  for (const via of ["token", "portal", "tailscale", "open"] as const) {
    expect(lockBoundary(grant(via), strict, { localProof: true })).toEqual({ level: "none", reason: "strict" });
  }
  expect(lockBoundary(grant("local"), strict, { localProof: false })).toEqual({ level: "none", reason: "strict" });
  expect(lockBoundary(row("remote"), strict, { localProof: false })).toEqual({ level: "none", reason: "strict" });
  expect(lockBoundary(row("pc"), strict, { localProof: false })).toEqual({ level: "none", reason: "strict" });
});

test("S19: PC-local still gets in while strict, so the screen proof and recovery stay usable", () => {
  expect(lockBoundary(grant("local"), strict, { localProof: true })).toEqual(grant("local"));
});

test("T46: a refusal stays a refusal, whatever the lock", () => {
  const refused: Access = { level: "none", reason: "pairing_required" };
  for (const scope of [open, locked, strict]) expect(lockBoundary(refused, scope, { localProof: true })).toBe(refused);
});
