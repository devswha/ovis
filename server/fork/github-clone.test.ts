import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { placeFolder, placeState, suggestedFolder } from "./github-clone.ts";

describe("clone folder", () => {
  it("takes ~ and absolute folders inside home only", () => {
    expect(placeFolder("~/Projects/app", "/home/u")).toBe("/home/u/Projects/app");
    expect(placeFolder("/home/u/x/../app", "/home/u")).toBe("/home/u/app");
    expect(placeFolder("~/../other", "/home/u")).toBeNull();
    expect(placeFolder("/etc/app", "/home/u")).toBeNull();
    expect(placeFolder("Projects/app", "/home/u")).toBeNull();
    expect(placeFolder("~", "/home/u")).toBeNull();
  });

  it("suggests the repository's name in the last parent, or ~/Projects", () => {
    expect(suggestedFolder("acme/api", null, "/home/u")).toBe("/home/u/Projects/api");
    expect(suggestedFolder("acme/api", "~/work", "/home/u")).toBe("/home/u/work/api");
    expect(suggestedFolder("acme/api", "/etc", "/home/u")).toBe("/home/u/Projects/api");
  });

  it("never calls a folder with something else in it free", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-"));
    expect(await placeState(join(root, "missing"), "acme/api")).toBe("free");
    mkdirSync(join(root, "empty"));
    expect(await placeState(join(root, "empty"), "acme/api")).toBe("free");
    mkdirSync(join(root, "full"));
    writeFileSync(join(root, "full", "notes.txt"), "mine");
    expect(await placeState(join(root, "full"), "acme/api")).toBe("taken");
    writeFileSync(join(root, "file"), "x");
    expect(await placeState(join(root, "file"), "acme/api")).toBe("taken");
    const checkout = join(root, "api");
    mkdirSync(checkout);
    spawnSync("git", ["init", "-q", checkout]);
    spawnSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/Acme/API.git"]);
    expect(await placeState(checkout, "acme/api")).toBe("same");
    expect(await placeState(checkout, "acme/web")).toBe("taken");
  });
});
