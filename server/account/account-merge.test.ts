import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAccountState } from "./account-merge.ts";
import { REMOVAL_FILE } from "./removal-evidence.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-account-merge-"));
  dirs.push(made);
  return made;
}
const put = (at: string, file: string, value: unknown) => writeFileSync(join(at, file), JSON.stringify(value), { mode: 0o600 });

describe("merging two folders' account state fails closed on what it cannot trust (T28, T48, S19)", () => {
  test("T28, S19: removal evidence of an unsupported form is refused, and neither folder is rewritten", () => {
    const [active, sibling] = [dir(), dir()];
    put(sibling, REMOVAL_FILE, { v: 2, markers: [], revokes: [], unrevokes: [] });
    expect(mergeAccountState(active, sibling)).not.toBeNull();
    expect(existsSync(join(active, REMOVAL_FILE))).toBe(false);
  });

  test("T28, S19: a held list that is not one is refused, never merged into holding nobody", () => {
    const [active, sibling] = [dir(), dir()];
    put(active, "account-held.json", { keys: [], full: false });
    put(sibling, "account-held.json", { keys: "everyone", full: "no" });
    expect(mergeAccountState(active, sibling)).not.toBeNull();
    expect(JSON.parse(readFileSync(join(active, "account-held.json"), "utf8"))).toEqual({ keys: [], full: false });
  });
});
