import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceStore } from "../preferences.ts";
import { bridgePins } from "./pin-label.ts";

type Record_ = { address: string; state: string; labels: Record<string, string> };

/** hc's label and event calls over terminals held here: a label write is told as hc tells it, a `labels` event. */
function fakeCore(terminals: Record_[]) {
  const written: { terminal: string; labels: Record<string, string> }[] = [];
  let onData: ((chunk: Uint8Array) => void) | null = null;
  const opened = Promise.withResolvers<void>();
  const tell = (event: Record<string, unknown>) => onData?.(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })}\n`));
  const hc = {
    call: async (method: string, params: { terminal: string; labels: Record<string, string> }) => {
      if (method !== "terminal.label") throw new Error(`unexpected ${method}`);
      written.push(params);
      const found = terminals.find((terminal) => terminal.address === params.terminal)!;
      for (const [key, value] of Object.entries(params.labels)) {
        if (value === "") delete found.labels[key];
        else found.labels[key] = value;
      }
      tell({ type: "labels", terminal: found.address, data: { labels: { ...found.labels } } });
      return found;
    },
    open: async (_method: string, _params: unknown, handlers: { onData: (chunk: Uint8Array) => void }) => {
      onData = handlers.onData;
      queueMicrotask(() => opened.resolve());
      return { result: { channel: 1, seq: 1, terminals: terminals.map((terminal) => ({ ...terminal, labels: { ...terminal.labels } })) }, channel: { close: async () => {} } };
    },
  };
  return { hc: hc as never, written, opened: opened.promise, tell };
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

function store(pins?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pins-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const preferences = new PreferenceStore(dir);
  if (pins) preferences.set({ settings: {}, pins });
  return preferences;
}

describe("bridgePins", () => {
  it("keeps both sides' pins when they first meet, and only this PC's agent pins", async () => {
    const preferences = store(["local:t2", "local:workspace:s1", "remote:t9"]);
    const core = fakeCore([
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
      { address: "t3", state: "live", labels: {} },
    ]);
    const stop = bridgePins(core.hc, preferences, "local");
    cleanups.push(stop);
    await core.opened;
    expect(preferences.get().pins).toEqual(["local:t2", "local:workspace:s1", "remote:t9", "local:t1"]);
    expect(core.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  it("writes a pin or unpin made in a browser on its terminal, and takes one made in the Herdr app", async () => {
    const preferences = store(["local:t1"]);
    const core = fakeCore([
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
    ]);
    cleanups.push(bridgePins(core.hc, preferences, "local"));
    await core.opened;
    preferences.set({ settings: {}, pins: ["local:t2"] });
    expect(core.written).toEqual([
      { terminal: "t1", labels: { "herdr.pinned": "" } },
      { terminal: "t2", labels: { "herdr.pinned": "1" } },
    ]);
    // the Herdr app unpins t2, then a new terminal starts pinned there
    core.tell({ type: "labels", terminal: "t2", data: { labels: {} } });
    core.tell({ type: "created", terminal: "t4", data: { address: "t4", state: "live", labels: { "herdr.pinned": "1" } } });
    expect(preferences.get().pins).toEqual(["local:t4"]);
    // a settings change from a browser writes nothing
    preferences.set({ settings: { theme: "dark" } });
    expect(core.written).toHaveLength(2);
  });

  it("unpins nothing while no browser has shared its pins", async () => {
    const preferences = store();
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    cleanups.push(bridgePins(core.hc, preferences, "local"));
    await core.opened;
    preferences.set({ settings: { theme: "dark" } });
    expect(core.written).toEqual([]);
    expect(preferences.get().pins).toBeUndefined();
  });
});
