import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "./herdr/client.ts";
import type { PaneInfo } from "../shared/protocol.ts";
import { WindowShareError, WindowShares } from "./window-share.ts";

describe("WindowShares", () => {
  let root: string;
  let paneGet: ReturnType<typeof spyOn<typeof client, "paneGet">>;
  let store: WindowShares;
  let now: number;
  const jpeg = (last: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, last]).toString("base64");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ovis-window-share-"));
    paneGet = spyOn(client, "paneGet").mockResolvedValue({ pane_id: "p1", cwd: root } as PaneInfo);
    now = 0;
    store = new WindowShares(root, () => now);
  });
  afterEach(() => {
    store.close();
    paneGet.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps one stable path with the latest complete frame, and removes it on stop", async () => {
    const { id, path } = await store.start("p1", jpeg(1));
    expect(path.startsWith(join(root, ".ovis"))).toBe(true);
    expect(readFileSync(path).at(-1)).toBe(1);
    store.update("p1", id, jpeg(2));
    expect(readFileSync(path).at(-1)).toBe(2);
    expect(() => store.update("p2", id, jpeg(3))).toThrow(WindowShareError);
    store.stop("p2", id);
    expect(existsSync(path)).toBe(true);
    store.stop("p1", id);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects non-JPEG bytes before looking up a pane", async () => {
    await expect(store.start("p1", Buffer.from("not an image").toString("base64"))).rejects.toMatchObject({ code: "invalid_frame", status: 400 });
    expect(paneGet).not.toHaveBeenCalled();
  });

  it("replaces a link without writing into its target", async () => {
    const { id, path } = await store.start("p1", jpeg(1));
    const target = join(root, "target.jpg");
    const original = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]);
    await Bun.write(target, original);
    rmSync(path);
    symlinkSync(target, path);
    store.update("p1", id, jpeg(2));
    expect(readFileSync(target)).toEqual(original);
    expect(readFileSync(path).at(-1)).toBe(2);
  });

  it("expires lost browsers and frees their files", async () => {
    const { id, path } = await store.start("p1", jpeg(1));
    now = 30_001;
    expect(() => store.update("p1", id, jpeg(2))).toThrow(WindowShareError);
    expect(existsSync(path)).toBe(false);
  });

  it("reaps a previous server's live file after a crash", async () => {
    const { path } = await store.start("p1", jpeg(1));
    // The old instance never closed: a new instance on the same state directory takes over.
    const restarted = new WindowShares(root, () => now);
    try { expect(existsSync(path)).toBe(false); }
    finally { restarted.close(); }
  });
});
