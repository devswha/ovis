/**
 * The `ovis confirm` command (docs/account.md, "Confirmed on this PC"; device table P11, R8, Q20): it finds this PC's
 * own confirm page from local-confirm.json in its own state folder, as the user that folder belongs to, and opens only
 * an address it builds itself.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfirm, type ConfirmIo } from "./plugin-confirm.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stateDir(file?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-confirm-"));
  dirs.push(dir);
  if (file !== undefined) writeFileSync(join(dir, "local-confirm.json"), typeof file === "string" ? file : JSON.stringify(file), { mode: 0o600 });
  return dir;
}

function io(dir: string, options: Partial<Pick<ConfirmIo, "platform" | "uid" | "desktop">> = {}) {
  const out: string[] = [];
  const opened: string[] = [];
  const value: ConfirmIo = {
    stateDir: dir, platform: options.platform ?? "linux", uid: "uid" in options ? options.uid : process.getuid?.(), desktop: options.desktop ?? true,
    out: (text) => { out.push(text); },
    open: (url) => { opened.push(url); },
  };
  return { value, opened, text: () => out.join("") };
}

test("prints the page it builds from the port and opens it where there is a desktop", async () => {
  const run = io(stateDir({ port: 41234 }));
  expect(await runConfirm(run.value)).toBe(0);
  expect(run.text()).toContain("http://127.0.0.1:41234/");
  expect(run.opened).toEqual(["http://127.0.0.1:41234/"]);
});

test("with no desktop, prints the page and opens nothing", async () => {
  const run = io(stateDir({ port: 41234 }), { desktop: false });
  expect(await runConfirm(run.value)).toBe(0);
  expect(run.text()).toContain("http://127.0.0.1:41234/");
  expect(run.opened).toEqual([]);
});

test("says plainly when no confirm page is open, and opens nothing", async () => {
  const run = io(stateDir());
  expect(await runConfirm(run.value)).toBe(1);
  expect(run.text()).toContain("No confirm page is open");
  expect(run.opened).toEqual([]);
});

test("t13r (2): a tampered file opens nothing: a host or URL of its own, a port that is not a whole number in range", async () => {
  for (const file of [
    { port: 41234, host: "evil.example" }, { port: 41234, url: "http://evil.example/" }, { port: "41234" }, { port: 41234.5 },
    { port: 0 }, { port: 65536 }, { port: -1 }, [41234], "not json", { },
  ]) {
    const run = io(stateDir(file));
    expect({ file, code: await runConfirm(run.value), opened: run.opened }).toEqual({ file, code: 1, opened: [] });
    expect(run.text()).not.toContain("http://");
  }
});

test("t13r (1): reads the file only as the user its state folder belongs to: another user (sudo included) gets nothing", async () => {
  const dir = stateDir({ port: 41234 });
  for (const uid of [0, (process.getuid?.() ?? 1000) + 1]) {
    const run = io(dir, { uid });
    expect({ uid, code: await runConfirm(run.value), opened: run.opened }).toEqual({ uid, code: 1, opened: [] });
    expect(run.text()).not.toContain("41234");
  }
});

test("P11: on macOS and Windows there is no confirm page yet: it says so and opens nothing", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const run = io(stateDir({ port: 41234 }), { platform });
    expect(await runConfirm(run.value)).toBe(1);
    expect(run.text()).toContain("Linux");
    expect(run.opened).toEqual([]);
  }
});
