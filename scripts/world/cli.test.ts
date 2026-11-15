import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

describe("cli.ts", () => {
  test("describe without a world's name says what it needs and exits 2", () => {
    const ran = Bun.spawnSync(["bun", CLI, "describe"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, OVIS_WORLD_SCRATCH: join(import.meta.dir, "no-such-scratch-root") } });
    expect(ran.exitCode).toBe(2);
    expect(ran.stdout.toString()).toBe("");
    expect(ran.stderr.toString().trim()).not.toBe("");
  });
});
