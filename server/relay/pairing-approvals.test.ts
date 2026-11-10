import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateStateFs } from "../private-state.ts";
import { PAIRING_WINDOW_MS, RelayPairingApprovals } from "./pairing-approvals.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** A window file in a directory of its own, and a clock the test moves. */
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-pairing-window-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, "relay", "pairing-window.json");
  const clock = { at: 1_700_000_000_000 };
  return {
    path, clock,
    /** what a server started now would read */
    open: () => new RelayPairingApprovals({ path, now: () => clock.at }),
    write(value: unknown) {
      mkdirSync(join(stateDir, "relay"), { recursive: true });
      writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    },
    saved: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
  };
}

describe("the pairing window across a restart", () => {
  it("is still open, and still local-only, for a server started on the same state", () => {
    const f = fixture();
    f.open().openWindow(f.clock.at, { localOnly: true });
    // both deadlines are in the one document
    expect(f.saved()).toEqual({ v: 1, window_until: f.clock.at + PAIRING_WINDOW_MS, local_only_until: f.clock.at + PAIRING_WINDOW_MS });
    f.clock.at += 60_000;
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(true);
    expect(restarted.localOnlyOpen()).toBe(true);
  });

  it("ends at the deadline it was opened with, not ten minutes after the restart", () => {
    const f = fixture();
    f.open().openWindow(f.clock.at, { localOnly: true });
    f.clock.at += PAIRING_WINDOW_MS - 1;
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(true);
    expect(restarted.localOnlyOpen()).toBe(true);
    f.clock.at += 1;
    expect(restarted.windowOpen()).toBe(false);
    expect(restarted.localOnlyOpen()).toBe(false);
    // and a server started after it reads it closed
    const later = f.open();
    expect(later.windowOpen()).toBe(false);
    expect(later.localOnlyOpen()).toBe(false);
  });

  it("clamps a stored deadline far in the future to a window opened now", () => {
    const f = fixture();
    f.write({ v: 1, window_until: f.clock.at + 365 * 86_400_000, local_only_until: Number.MAX_SAFE_INTEGER });
    const restarted = f.open();
    expect(restarted.windowOpen(f.clock.at + PAIRING_WINDOW_MS - 1)).toBe(true);
    expect(restarted.localOnlyOpen(f.clock.at + PAIRING_WINDOW_MS - 1)).toBe(true);
    expect(restarted.windowOpen(f.clock.at + PAIRING_WINDOW_MS)).toBe(false);
    expect(restarted.localOnlyOpen(f.clock.at + PAIRING_WINDOW_MS)).toBe(false);
  });

  it("stays not local-only when it was opened without it", () => {
    const f = fixture();
    f.open().openWindow(f.clock.at);
    expect(f.saved()).toEqual({ v: 1, window_until: f.clock.at + PAIRING_WINDOW_MS, local_only_until: 0 });
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(true);
    expect(restarted.localOnlyOpen()).toBe(false);
  });

  it("keeps an earlier local-only deadline when the window is opened again without it", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    f.clock.at += 60_000;
    approvals.openWindow(f.clock.at);
    expect(f.saved()).toEqual({ v: 1, window_until: f.clock.at + PAIRING_WINDOW_MS, local_only_until: f.clock.at - 60_000 + PAIRING_WINDOW_MS });
  });

  it.each([
    ["no file", undefined],
    ["only the window", { v: 1, window_until: 1_700_000_300_000 }],
    ["only the local-only half", { v: 1, local_only_until: 1_700_000_300_000 }],
    ["a window that is not a number", { v: 1, window_until: "1700000300000", local_only_until: 1_700_000_300_000 }],
    ["a local-only half that is not a number", { v: 1, window_until: 1_700_000_300_000, local_only_until: true }],
    ["a local-only half of null", { v: 1, window_until: 1_700_000_300_000, local_only_until: null }],
    ["another version", { v: 2, window_until: 1_700_000_300_000, local_only_until: 1_700_000_300_000 }],
    ["no version", { window_until: 1_700_000_300_000, local_only_until: 1_700_000_300_000 }],
    ["a list", [1_700_000_300_000, 1_700_000_300_000]],
    ["damaged JSON", '{ "v": 1, "window_until": 1700000300000, "local_only_'],
    // JSON has no Infinity: 1e999 parses to it
    ["a deadline that is not finite", '{ "v": 1, "window_until": 1e999, "local_only_until": 1700000300000 }'],
  ])("reads %s as closed", (_name, content) => {
    const f = fixture();
    if (content !== undefined) f.write(content);
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(false);
    expect(restarted.localOnlyOpen()).toBe(false);
  });

  it("closes for this server and the next one", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    approvals.closeWindow();
    expect(approvals.windowOpen()).toBe(false);
    expect(approvals.localOnlyOpen()).toBe(false);
    expect(f.saved()).toEqual({ v: 1, window_until: 0, local_only_until: 0 });
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(false);
    expect(restarted.localOnlyOpen()).toBe(false);
  });

  it("writes nothing when a window that was never opened is closed", () => {
    const f = fixture();
    f.open().closeWindow();
    expect(existsSync(f.path)).toBe(false);
  });

  it("still opens in memory when the file cannot be written, and says so", () => {
    const f = fixture();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const open = spyOn(privateStateFs, "openSync").mockImplementation(() => { throw new Error("disk full"); });
    cleanup.push(() => { warn.mockRestore(); open.mockRestore(); });
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    expect(approvals.windowOpen()).toBe(true);
    expect(approvals.localOnlyOpen()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(existsSync(f.path)).toBe(false);
  });

  it("removes a file it cannot rewrite on close, so the next server does not reopen the window", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const open = spyOn(privateStateFs, "openSync").mockImplementation(() => { throw new Error("disk full"); });
    cleanup.push(() => { warn.mockRestore(); open.mockRestore(); });
    approvals.closeWindow();
    expect(approvals.windowOpen()).toBe(false);
    expect(existsSync(f.path)).toBe(false);
    expect(f.open().windowOpen()).toBe(false);
  });

  it("removes an older window it cannot replace on open, so it never comes back without its local-only half", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at);
    expect(f.open().windowOpen()).toBe(true);
    expect(f.open().localOnlyOpen()).toBe(false);
    f.clock.at += 60_000;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const open = spyOn(privateStateFs, "openSync").mockImplementation(() => { throw new Error("disk full"); });
    cleanup.push(() => { warn.mockRestore(); open.mockRestore(); });
    approvals.openWindow(f.clock.at, { localOnly: true });
    open.mockRestore();
    // this process still has the window it opened
    expect(approvals.windowOpen()).toBe(true);
    expect(approvals.localOnlyOpen()).toBe(true);
    expect(existsSync(f.path)).toBe(false);
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(false);
    expect(restarted.localOnlyOpen()).toBe(false);
  });

  it("keeps nothing on disk without a path", () => {
    const approvals = new RelayPairingApprovals();
    approvals.openWindow();
    expect(approvals.windowOpen()).toBe(true);
    approvals.closeWindow();
    expect(approvals.windowOpen()).toBe(false);
  });
});
