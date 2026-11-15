import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { selectUnitFiles, unitShard } from "./fork-unit-shard.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fork-unit-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

it("uses upstream's unit file boundary, including Copilot, with no hidden exclusions", () => {
  const unit = ["src/a.test.tsx", "shared/a.test.ts", "server/copilot.test.ts", "scripts/a.test.ts", "telemetry/a.test.ts", "push-relay/a.test.ts", "relay/a.test.ts", "integrations/a.test.ts"];
  const integration = ["server/a.contract.test.ts", "server/updater.test.ts", "server/herdr/a.test.ts", "server/pty/a.test.ts"];
  const root = fixture(Object.fromEntries([...unit, ...integration, "other/a.test.ts", "src/not-a-test.ts"].map((name) => [name, ""])));
  expect(selectUnitFiles(root)).toEqual(unit.sort());
});

it("splits the sorted list deterministically and covers every file exactly once", () => {
  const files = Array.from({ length: 19 }, (_, index) => `src/${index}.test.ts`);
  const shards = [1, 2, 3, 4].map((index) => unitShard(files, `${index}/4`));
  expect(shards.map((shard) => shard.length)).toEqual([5, 5, 5, 4]);
  expect(shards.flat().sort()).toEqual([...files].sort());
  expect(new Set(shards.flat()).size).toBe(files.length);
  expect(unitShard([...files].reverse(), "2/4")).toEqual(shards[1]!);
});

it.each(["0/4", "5/4", "1/0", "1.5/4", "bad", "1/Infinity"])("rejects invalid shard %s", (shard) => {
  expect(() => unitShard(["src/a.test.ts"], shard)).toThrow("shard");
});

it("runs each file in isolation and propagates a failed file", () => {
  const root = fixture({
    "src/pass.test.ts": 'import {expect,it} from "bun:test"; it("unit mode",()=>expect(process.env.HERDR_TEST_MODE).toBe("unit"));',
    "src/fail.test.ts": 'import {expect,it} from "bun:test"; it("failure is not hidden",()=>expect(1).toBe(2));',
    "src/empty.test.ts": "process.exit(0);",
  });
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "fork-unit-shard.ts"), "--shard", "1/1"], {
    cwd: root, env: { ...process.env, UNIT_TEST_WORKERS: "2" }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("FAILED src/fail.test.ts");
  expect(result.stdout.toString()).toContain("FAILED src/empty.test.ts");
  expect(result.stdout.toString()).not.toContain("FAILED src/pass.test.ts");
});
