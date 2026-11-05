import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERDR_DEFAULT_PREFIX, HERDR_PREFIX_DEFAULTS } from "../shared/herdr-keys.ts";
import { readHerdrUi } from "./herdr-ui.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function config(contents: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
  roots.push(root);
  const path = join(root, "config.toml");
  writeFileSync(path, contents);
  return path;
}

describe("herdr's [ui] copy_on_select", () => {
  it("reads the value herdr's config sets", () => {
    expect(readHerdrUi(config("[ui]\ncopy_on_select = false\n")).copy_on_select).toBe(false);
    expect(readHerdrUi(config("[ui]\ncopy_on_select = true\n")).copy_on_select).toBe(true);
    expect(readHerdrUi(config("[ui]\r\ntheme = 'dark'\r\ncopy_on_select = false\r\n")).copy_on_select).toBe(false);
  });

  it("reads it past the byte-order marks herdr strips at the start of a line", () => {
    expect(readHerdrUi(config("\uFEFF[ui]\n\uFEFFcopy_on_select = false\n")).copy_on_select).toBe(false);
  });

  it("is herdr's default (on) for a value that is no boolean, another table, no config or no TOML", () => {
    for (const contents of ["", "[ui]\ntheme = 'dark'", "[other]\ncopy_on_select = false", "[ui]\ncopy_on_select = 'false'", "[ui]\ncopy_on_select = 0", "ui = false", "[ui"]) {
      expect(readHerdrUi(config(contents)).copy_on_select).toBe(true);
    }
    const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
    roots.push(root);
    expect(readHerdrUi(join(root, "missing.toml")).copy_on_select).toBe(true);
    expect(readHerdrUi(root).copy_on_select).toBe(true);
  });

  it("reads no special file, and no file larger than a config", () => {
    expect(readHerdrUi(config(Buffer.alloc(1024 * 1024 + 1, "#"))).copy_on_select).toBe(true);
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
    roots.push(root);
    const fifo = join(root, "config.toml");
    Bun.spawnSync(["mkfifo", fifo]);
    // a FIFO with no writer would block a plain read: it is no config, read at once
    expect(readHerdrUi(fifo).copy_on_select).toBe(true);
  });
});

describe("herdr's [keys] prefix bindings", () => {
  const defaults = { prefix: HERDR_DEFAULT_PREFIX, bindings: { ...HERDR_PREFIX_DEFAULTS } };

  it("are herdr's defaults without a config, without [keys], or with a config herdr cannot parse", () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
    roots.push(root);
    expect(readHerdrUi(join(root, "missing.toml")).keys).toEqual(defaults);
    expect(readHerdrUi(config("[ui]\ncopy_on_select = false\n")).keys).toEqual(defaults);
    expect(readHerdrUi(config("[keys")).keys).toEqual(defaults);
  });

  it("take the prefix and each binding the config writes, an empty one unbinding the action", () => {
    const keys = readHerdrUi(config('[keys]\nprefix = "ctrl+a"\nnew_tab = "prefix+t"\nzoom = ""\nnext_workspace = "prefix+shift+right"\n')).keys;
    expect(keys).toEqual({ prefix: "ctrl+a", bindings: { ...HERDR_PREFIX_DEFAULTS, new_tab: "prefix+t", zoom: "", next_workspace: "prefix+shift+right" } });
  });

  it("unbind a value that is no string, and never carry a custom command or another action", () => {
    const keys = readHerdrUi(config('[keys]\nprefix = 1\nsplit_vertical = ["prefix+v"]\nclose_pane = "prefix+x"\n[[keys.command]]\nkey = "prefix+alt+g"\ntype = "shell"\ncommand = "rm -rf ~"\n')).keys;
    expect(keys?.prefix).toBe("");
    expect(keys?.bindings.split_vertical).toBe("");
    expect(JSON.stringify(keys)).not.toContain("rm -rf");
    expect(Object.keys(keys?.bindings ?? {})).toEqual(Object.keys(HERDR_PREFIX_DEFAULTS));
  });
});
