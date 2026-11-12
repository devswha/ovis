import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMPILED, ENTRIES, entryCommand, ROOT, type EntryName } from "./entries.ts";

const root = join(import.meta.dir, "..");

async function main(...args: string[]): Promise<{ code: number; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["OVIS_HC_MACHINE"];
  delete env["OVIS_HC_MACHINE_STATE"];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args], { cwd: root, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

describe("server entries", () => {
  it("starts each entry from its own file when run from source", () => {
    expect(COMPILED).toBe(false);
    expect(ROOT).toBe(root);
    for (const name of Object.keys(ENTRIES) as EntryName[]) {
      const [runtime, file] = entryCommand(name);
      expect(runtime).toBe(process.execPath);
      expect(file).toBe(join(root, ENTRIES[name].file));
      expect(existsSync(file)).toBe(true);
    }
    expect(entryCommand("serve", "/elsewhere")[1]).toBe(join("/elsewhere", "server", "index.ts"));
  });

  it("refuses an unknown entry with exit 2, naming every entry", async () => {
    const { code, stderr } = await main("nosuch");
    expect(code).toBe(2);
    for (const name of Object.keys(ENTRIES)) expect(stderr).toContain(name);
    expect((await main()).code).toBe(2);
  });

  it("runs the named entry, which refuses a machine start nothing asked for", async () => {
    const { code, stderr } = await main("machine");
    expect(code).not.toBe(0);
    expect(stderr).toContain("machine-entry.ts runs only as machine-bridge.ts starts it");
  });
});
