import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_MARK, CONTEXT_STALE_MS, contextFilename, contextProfile, pruneContextFiles, publishContext, removeContextFile } from "./statusline-context.ts";

let home: string;
let directory: string;
let profile: string;
const capture = { session_id: "session-a", model: "claude-test", window: 1_000_000 };
const target = () => join(directory, contextFilename(profile, capture.session_id));
const saved = () => `${CONTEXT_MARK}${JSON.stringify({ ...capture, _herdr: { profile } }).slice(1)}`;
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "ovis-context-protocol-"));
  directory = join(home, "contexts");
  fs.mkdirSync(directory, { mode: 0o700 });
  profile = contextProfile(home);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("session context publication and quarantine", () => {
  it("preserves a user file that wins exclusive temp creation", () => {
    const open = fs.openSync;
    let collision: string | null = null;
    const hook = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[1] === "wx") {
        collision = String(args[0]);
        fs.writeFileSync(collision, "user temp");
      }
      return open(...args);
    });
    try {
      publishContext(directory, profile, capture);
    } finally {
      hook.mockRestore();
    }
    expect(collision).not.toBeNull();
    expect(fs.readFileSync(collision!, "utf8")).toBe("user temp");
    expect(fs.existsSync(target())).toBe(false);
  });

  it("preserves an unmarked entry swapped in before the target is quarantined", () => {
    fs.writeFileSync(target(), saved());
    const rename = fs.renameSync;
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === target()) {
        fs.unlinkSync(target());
        fs.writeFileSync(target(), "user replacement");
      }
      rename(from, to);
    });
    try {
      publishContext(directory, profile, { ...capture, window: 200_000 });
    } finally {
      hook.mockRestore();
    }
    expect(fs.readFileSync(target(), "utf8")).toBe("user replacement");
    expect(fs.readdirSync(directory)).toEqual([contextFilename(profile, capture.session_id)]);
  });

  it("keeps both user entries when restoring quarantine encounters a newcomer", () => {
    fs.writeFileSync(target(), "original user file");
    const rename = fs.renameSync;
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(from) === target()) fs.writeFileSync(target(), "new user file");
    });
    try {
      expect(removeContextFile(target(), profile)).toBe(false);
    } finally {
      hook.mockRestore();
    }
    expect(fs.readFileSync(target(), "utf8")).toBe("new user file");
    const recovery = fs.readdirSync(directory).find(name => name.startsWith("statusline-context-recovery-"));
    expect(recovery).toBeDefined();
    expect(fs.readFileSync(join(directory, recovery!), "utf8")).toBe("original user file");
    expect(fs.readdirSync(directory).some(name => name.startsWith("."))).toBe(false);
  });

  it("gives up without overwriting a newcomer after an own capture is removed", () => {
    fs.writeFileSync(target(), saved());
    const unlink = fs.unlinkSync;
    const hook = spyOn(fs, "unlinkSync").mockImplementation(path => {
      unlink(path);
      if (String(path).endsWith(".quarantine")) fs.writeFileSync(target(), "newcomer");
    });
    try {
      publishContext(directory, profile, { ...capture, window: 200_000 });
    } finally {
      hook.mockRestore();
    }
    expect(fs.readFileSync(target(), "utf8")).toBe("newcomer");
  });

  it("does not chmod or follow an unsafe directory and still preserves its contents", () => {
    const outside = join(home, "outside");
    fs.mkdirSync(outside, { mode: 0o755 });
    fs.rmdirSync(directory);
    fs.symlinkSync(outside, directory);
    publishContext(directory, profile, capture);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
    fs.unlinkSync(directory);
    fs.mkdirSync(directory, { mode: 0o755 });
    publishContext(directory, profile, capture);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
  });

  it("limits stale pruning to 128 entries per run", () => {
    const now = 1_800_000_000_000;
    const old = new Date(now - CONTEXT_STALE_MS - 1);
    for (let index = 0; index < 140; index++) {
      const path = join(directory, contextFilename(profile, "session-" + index));
      fs.writeFileSync(path, saved());
      fs.utimesSync(path, old, old);
    }
    pruneContextFiles(directory, profile, now);
    expect(fs.readdirSync(directory)).toHaveLength(12);
  });
});
