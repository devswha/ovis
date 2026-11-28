import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashRecord, recordCrash } from "./crash.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const AT = new Date(Date.UTC(2030, 0, 1));

describe("the crash record", () => {
  it("keeps a message line that reads like a frame out of the frames", () => {
    const error = new Error("the first line\n    at private text the error quoted");
    const { frames } = crashRecord("1.0.0", null, error, AT).error;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((frame) => frame.includes("private text"))).toBe(false);
  });

  it("gives the terminal back before it reads the error, so an error that cannot be read still leaves the terminal restored", () => {
    const folder = join(root, "unreadable");
    const error = new Error("x");
    Object.defineProperty(error, "stack", { get: () => { throw new Error("the stack cannot be read"); } });
    const order: string[] = [];
    expect(() => recordCrash(() => { order.push("leave"); }, folder, () => crashRecord("1.0.0", null, error, AT), process.pid)).toThrow("the stack cannot be read");
    expect({ order, written: existsSync(folder) }).toEqual({ order: ["leave"], written: false });
  });
});
