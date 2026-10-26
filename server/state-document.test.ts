import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readStateDocument, setAsideDamaged } from "./state-document.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "herdr-state-document-")); dirs.push(dir); return dir; };

describe("setAsideDamaged", () => {
  it("moves a file of NULs aside, bytes untouched, under a name a Windows file may have", () => {
    const dir = directory(), path = join(dir, "machines.json");
    const zeros = Buffer.alloc(353);
    writeFileSync(path, zeros);
    expect(readStateDocument(path)).toEqual({ kind: "malformed" });
    const aside = setAsideDamaged(path, new Date("2026-10-26T07:06:23.123Z"));
    expect(basename(aside)).toBe("machines.json.corrupt-2026-10-26T07-06-23-123Z");
    expect(readFileSync(aside)).toEqual(zeros);
    expect(readStateDocument(path)).toEqual({ kind: "missing" });
  });

  it("keeps every damaged copy: a later one never replaces an earlier one", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "first");
    setAsideDamaged(path, new Date("2026-10-24T01:00:00.000Z"));
    writeFileSync(path, "second");
    setAsideDamaged(path, new Date("2026-10-26T01:00:00.000Z"));
    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(2);
    expect(kept.map((name) => readFileSync(join(dir, name), "utf8"))).toEqual(["first", "second"]);
  });

  it("throws, naming the file and why, when it cannot be moved", () => {
    const dir = directory();
    expect(() => setAsideDamaged(join(dir, "machines.json"))).toThrow(/^machines\.json is not JSON and cannot be set aside as machines\.json\.corrupt-\S+ \(ENOENT\)$/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
