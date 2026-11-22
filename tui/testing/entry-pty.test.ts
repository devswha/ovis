import { describe, expect, it } from "bun:test";
import { closedBoxes, drainTail, runBounded, shutdownOwned } from "./entry-pty.ts";

const ENV = { PATH: "/usr/bin:/bin" };
const TEST_MS = 20_000;
const bounds = { cwd: "/", env: ENV, deadlineMs: 400, maxBytes: 4096, graceMs: 400 };
// a SIGTERM stays ignored across exec, so only SIGKILL ends it
const STUBBORN = ["sh", "-c", 'trap "" TERM; exec sleep 30'];
const spawn = (command: string[]) => Bun.spawn(command, { env: ENV, stdin: "ignore", stdout: "ignore", stderr: "ignore" });

describe("runBounded", () => {
  it("returns the code and both streams of a command that ends in time", async () => {
    expect(await runBounded(["sh", "-c", "printf out; printf err >&2; exit 3"], bounds)).toEqual({ code: 3, out: "out", err: "err" });
  }, TEST_MS);

  it("stops a command that hangs, with SIGTERM when that is enough", async () => {
    await expect(runBounded(["sh", "-c", "exec sleep 30"], bounds)).rejects.toThrow(/did not finish within 400 ms \(stopped with SIGTERM\)/);
  }, TEST_MS);

  it("kills a command that ignores SIGTERM and says so", async () => {
    await expect(runBounded(STUBBORN, bounds)).rejects.toThrow(/\(stopped with SIGKILL\)/);
  }, TEST_MS);

  it("rejects a response past the byte limit and stops the flooding command", async () => {
    await expect(runBounded(["yes"], { ...bounds, deadlineMs: 10_000 })).rejects.toThrow(/passed 4096 bytes/);
    await expect(runBounded(["sh", "-c", "yes >&2"], { ...bounds, deadlineMs: 10_000 })).rejects.toThrow(/passed 4096 bytes/);
  }, TEST_MS);
});

describe("shutdownOwned", () => {
  it("does not force a child that stops after the request", async () => {
    const child = spawn(["sleep", "30"]);
    expect(await shutdownOwned(child, async () => { child.kill("SIGTERM"); }, 2000)).toEqual({ forced: null, askError: undefined });
  }, TEST_MS);

  it("ends a child through its handle when the request does nothing, and reports the signal", async () => {
    const child = spawn(["sleep", "30"]);
    expect(await shutdownOwned(child, async () => {}, 300)).toEqual({ forced: "SIGTERM", askError: undefined });
    expect(child.signalCode).toBe("SIGTERM");
  }, TEST_MS);

  it("kills a child that ignores SIGTERM and keeps the request's error", async () => {
    const child = spawn(STUBBORN);
    const failure = new Error("stop hung");
    const ended = await shutdownOwned(child, () => Promise.reject(failure), 300);
    expect(ended).toEqual({ forced: "SIGKILL", askError: failure });
    expect(child.signalCode).toBe("SIGKILL");
  }, TEST_MS);
});

describe("drainTail", () => {
  it("keeps only the last characters of a flood and reads it to the end", async () => {
    const child = Bun.spawn(["sh", "-c", 'head -c 300000 /dev/zero | tr "\\0" x; printf END'], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const tail = drainTail(child.stdout, 64);
    await tail.done;
    expect(tail.text()).toHaveLength(64);
    expect(tail.text().endsWith("xxEND")).toBe(true);
  }, TEST_MS);
});

describe("closedBoxes", () => {
  const frame = ["┌──┐", "│  │", "└──┘"].join("\n");

  it("finds a closed frame by its corners and sides, not by what it says", () => {
    expect(closedBoxes(`${frame}\n`)).toEqual(["0,0,2,3"]);
    expect(closedBoxes(["  ╭────╮", "  │ hi │", "  ╰────╯"].join("\n"))).toEqual(["0,2,2,7"]);
  });

  it("finds nothing in a frame cut short, and tells a new frame from the one before", () => {
    expect(closedBoxes(["┌──┐", "│  │", "└──"].join("\n"))).toEqual([]);
    expect(closedBoxes(["┌──┐", "│  │"].join("\n"))).toEqual([]);
    const before = new Set(closedBoxes(frame));
    expect(closedBoxes(`${frame}\n ┌───┐\n │   │\n └───┘`).filter((box) => !before.has(box))).toEqual(["3,1,5,5"]);
  });
});
