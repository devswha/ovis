import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_ACTIVITY_FILE, trackDesktopActivity } from "./desktop-activity.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-desktop-activity-"));
  dirs.push(dir);
  return dir;
}

const read = (dir: string): unknown => JSON.parse(readFileSync(join(dir, DESKTOP_ACTIVITY_FILE), "utf8"));

describe("trackDesktopActivity", () => {
  it("writes how many agents work, keeps the last count when a read fails, and leaves no file once stopped", async () => {
    const dir = stateDir();
    let answer: () => Promise<number> = async () => 2;
    const activity = trackDesktopActivity({ path: join(dir, DESKTOP_ACTIVITY_FILE), working: () => answer() });
    await activity.refresh();
    expect(read(dir)).toEqual({ working: 2 });
    answer = async () => 0;
    await activity.refresh();
    expect(read(dir)).toEqual({ working: 0 });
    answer = async () => { throw new Error("hc is not answering"); };
    await activity.refresh();
    expect(read(dir)).toEqual({ working: 0 });
    activity.stop();
    expect(existsSync(join(dir, DESKTOP_ACTIVITY_FILE))).toBe(false);
  });
});
