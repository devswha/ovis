import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PINS } from "../../shared/preferences.ts";
import { PreferenceStore } from "../preferences.ts";
import { bridgePins } from "./pin-label.ts";

type Held = { address: string; state: string; labels: Record<string, string> };

/**
 * hc's label and event calls over terminals held here: a label write comes back as hc tells it, a
 * `labels` event. `early` events reach the stream before its snapshot does, as hc may send them.
 */
function fakeCore(terminals: Held[]) {
  const written: { terminal: string; labels: Record<string, string> }[] = [];
  const state = { failing: false, early: [] as Record<string, unknown>[] };
  let onData: ((chunk: Uint8Array) => void) | null = null;
  let onClose: (() => void) | null = null;
  let opened = Promise.withResolvers<void>();
  const tell = (event: Record<string, unknown>) => onData?.(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })}\n`));
  const hc = {
    hello: async () => ({ version: "0.1.17", core: { id: "c1", name: "lab" } }),
    call: async (method: string, params: { terminal: string; labels: Record<string, string> }) => {
      if (method !== "terminal.label") throw new Error(`unexpected ${method}`);
      if (state.failing) throw new Error("hc is not answering");
      written.push(params);
      const found = terminals.find((terminal) => terminal.address === params.terminal)!;
      for (const [key, value] of Object.entries(params.labels)) {
        if (value === "") delete found.labels[key];
        else found.labels[key] = value;
      }
      tell({ type: "labels", terminal: found.address, data: { labels: { ...found.labels } } });
      return found;
    },
    open: async (_method: string, _params: unknown, handlers: { onData: (chunk: Uint8Array) => void; onClose: () => void }) => {
      onData = handlers.onData;
      onClose = handlers.onClose;
      for (const event of state.early.splice(0)) tell(event);
      const snapshot = terminals.map((terminal) => ({ ...terminal, labels: { ...terminal.labels } }));
      queueMicrotask(() => opened.resolve());
      return { result: { channel: 1, seq: 1, terminals: snapshot }, channel: { close: async () => {} } };
    },
  };
  /** the stream ends, as when hc restarts; resolves once the bridge has read the next snapshot */
  const drop = () => { opened = Promise.withResolvers<void>(); onClose?.(); return opened.promise; };
  return { hc: hc as never, written, state, tell, drop, opened: () => opened.promise };
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pins-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function store(dir: string, pins?: string[]) {
  const preferences = new PreferenceStore(dir);
  if (pins) preferences.set({ settings: {}, pins });
  return preferences;
}

function bridge(core: ReturnType<typeof fakeCore>, preferences: PreferenceStore, dir: string) {
  const pins = bridgePins(core.hc, preferences, "local", dir, 0);
  cleanups.push(pins.stop);
  return pins;
}

describe("bridgePins", () => {
  it("keeps both sides' pins when they first meet, and only this PC's agent pins", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t2", "local:workspace:s1", "remote:t9"]);
    const core = fakeCore([
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
      { address: "t3", state: "live", labels: {} },
    ]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t2", "local:workspace:s1", "remote:t9", "local:t1"]);
    expect(core.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  it("writes a pin or unpin made in a browser on its terminal, and takes one made in the Herdr app", async () => {
    const dir = stateDir();
    const preferences = store(dir, ["local:t1"]);
    const core = fakeCore([
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
    ]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    preferences.set({ settings: {}, pins: ["local:t2"] });
    await pins.idle();
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
    await pins.idle();
    expect(core.written).toHaveLength(2);
  });

  it("keeps an unpin made in the Herdr app while Ovis was stopped, and one made in Ovis while hc was away", async () => {
    const dir = stateDir();
    const terminals: Held[] = [
      { address: "t1", state: "live", labels: { "herdr.pinned": "1" } },
      { address: "t2", state: "live", labels: {} },
    ];
    const core = fakeCore(terminals);
    const first = bridge(core, store(dir, ["local:t1"]), dir);
    await core.opened();
    await first.idle();
    first.stop();
    // Ovis stopped; the Herdr app unpins t1, and a browser had pinned t2 meanwhile
    delete terminals[0]!.labels["herdr.pinned"];
    const preferences = new PreferenceStore(dir);
    preferences.set({ settings: {}, pins: ["local:t1", "local:t2"] });
    const again = fakeCore(terminals);
    const second = bridge(again, preferences, dir);
    await again.opened();
    await second.idle();
    expect(preferences.get().pins).toEqual(["local:t2"]);
    expect(again.written).toEqual([{ terminal: "t2", labels: { "herdr.pinned": "1" } }]);
  });

  it("writes a pin made while hc refused it once hc is back, instead of taking it for an unpin", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    core.state.failing = true;
    preferences.set({ settings: {}, pins: ["local:t1"] });
    await pins.idle();
    core.state.failing = false;
    await core.drop();
    await pins.idle();
    expect(preferences.get().pins).toEqual(["local:t1"]);
    expect(core.written).toEqual([{ terminal: "t1", labels: { "herdr.pinned": "1" } }]);
  });

  it("applies an event that came before its stream's snapshot after it", async () => {
    const dir = stateDir();
    const preferences = store(dir, []);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    core.state.early.push({ type: "labels", terminal: "t1", data: { labels: { "herdr.pinned": "1" } } });
    bridge(core, preferences, dir);
    await core.opened();
    expect(preferences.get().pins).toEqual(["local:t1"]);
  });

  it("leaves a pin from the Herdr app out when the list is full, never past what the server reads back", async () => {
    const dir = stateDir();
    const full = Array.from({ length: MAX_PINS }, (_, index) => `local:workspace:w${index}`);
    const preferences = store(dir, full);
    const core = fakeCore([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    await pins.idle();
    expect(preferences.get().pins).toHaveLength(MAX_PINS);
    expect(new PreferenceStore(dir).get().pins).toHaveLength(MAX_PINS);
    expect(core.written).toEqual([]);
    // a later change of anything else does not take it for an unpin
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(core.written).toEqual([]);
  });

  it("unpins nothing while no browser has shared its pins", async () => {
    const dir = stateDir();
    const preferences = store(dir);
    const core = fakeCore([{ address: "t1", state: "live", labels: {} }]);
    const pins = bridge(core, preferences, dir);
    await core.opened();
    preferences.set({ settings: { theme: "dark" } });
    await pins.idle();
    expect(core.written).toEqual([]);
    expect(preferences.get().pins).toBeUndefined();
  });
});
