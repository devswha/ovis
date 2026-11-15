import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratch, scratchOwners } from "./teardown.ts";

describe("the owner.json files of a scratch root", () => {
  it("are read, and one that cannot be read is said and skipped, never a stop", () => {
    const root = mkdtempSync(join(tmpdir(), "world-owners-"));
    const folder = (name: string, text: string) => { mkdirSync(join(root, name)); writeFileSync(join(root, name, "owner.json"), text); };
    folder("w1", JSON.stringify({ name: "w1", owner: "12:34", expires: 99, scratch: join(root, "w1") }));
    folder("w2", "");
    folder("w3", "{\"name\":\"w3\"}");
    mkdirSync(join(root, "w4"));
    const said: string[] = [];
    expect(scratchOwners([root, join(root, "missing")], (line) => said.push(line))).toEqual([{ name: "w1", owner: "12:34", expires: 99, scratch: join(root, "w1") }]);
    expect(said).toHaveLength(2);
    expect(existsSync(join(root, "w2"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the owner's handlers", () => {
  /** A process that owns one stand-in world (its teardown writes a file) and then ends as `end` says. */
  const owner = (end: string) => {
    const dir = mkdtempSync(join(tmpdir(), "world-owner-"));
    const script = join(dir, "owner.ts");
    writeFileSync(script, `import { teardownOnSignals } from ${JSON.stringify(join(import.meta.dir, "teardown.ts"))};
teardownOnSignals({ name: "w1", async teardown() { await Bun.write(${JSON.stringify(join(dir, "removed"))}, "w1"); } });
${end}\n`);
    const ran = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
    const removed = existsSync(join(dir, "removed"));
    rmSync(dir, { recursive: true, force: true });
    return { code: ran.exitCode, removed };
  };

  it("remove the world when the owner's process ends by itself", () => {
    expect(owner("")).toEqual({ code: 0, removed: true });
  });

  it("are skipped by process.exit, which the reaper then finishes", () => {
    expect(owner("process.exit(3);")).toEqual({ code: 3, removed: false });
  });
});

describe("a world's scratch folder", () => {
  const root = () => mkdtempSync(join(tmpdir(), "world-scratch-"));
  const scratchOf = (world: string, under: string) => {
    const scratch = join(under, world);
    mkdirSync(join(scratch, "bin"), { recursive: true });
    writeFileSync(join(scratch, "bin", "herdr"), "a binary");
    writeFileSync(join(scratch, "owner.json"), JSON.stringify({ name: world }));
    return scratch;
  };

  // root removes a file whatever its folder's mode says, so the removal could not be stopped part-way this way
  it.skipIf(process.getuid?.() === 0)("loses owner.json last, so a removal stopped part-way can still be finished", () => {
    const under = root();
    const scratch = scratchOf("w1", under);
    chmodSync(join(scratch, "bin"), 0o500);
    expect(() => removeScratch("w1", scratch)).toThrow();
    expect(existsSync(join(scratch, "owner.json"))).toBe(true);
    chmodSync(join(scratch, "bin"), 0o700);
    expect(removeScratch("w1", scratch)).toBe(true);
    expect(existsSync(scratch)).toBe(false);
    rmSync(under, { recursive: true, force: true });
  });

  it("goes when a killed removal left it empty, and is gone already when it is not there", () => {
    const under = root();
    mkdirSync(join(under, "w2"));
    expect(removeScratch("w2", join(under, "w2"))).toBe(true);
    expect(existsSync(join(under, "w2"))).toBe(false);
    expect(removeScratch("w2", join(under, "w2"))).toBe(true);
    rmSync(under, { recursive: true, force: true });
  });

  it("is kept and said when it is not that world's: another name, another world's owner.json, no owner.json", () => {
    const under = root();
    const said: string[] = [];
    const kept = (world: string, folder: string) => removeScratch(world, folder, (line) => said.push(line));
    mkdirSync(join(under, "elsewhere"));
    expect(kept("w3", join(under, "elsewhere"))).toBe(false);
    expect(kept("w4", scratchOf("w5", under))).toBe(false);
    mkdirSync(join(under, "w6"));
    writeFileSync(join(under, "w6", "keep.txt"), "a folder no world made");
    expect(kept("w6", join(under, "w6"))).toBe(false);
    expect([existsSync(join(under, "elsewhere")), existsSync(join(under, "w5", "owner.json")), existsSync(join(under, "w6", "keep.txt"))]).toEqual([true, true, true]);
    expect(said).toHaveLength(3);
    rmSync(under, { recursive: true, force: true });
  });
});
