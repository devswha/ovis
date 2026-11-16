import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { GhosttyExports, GhosttyModule } from "../../shared/ghostty/engine.ts";
import { TERMINAL_HISTORY_LINES } from "../../shared/terminal-flow.ts";
import { createEmulator, createEmulatorLoader, MAX_COLS, MAX_ROWS } from "./ghostty.ts";
import type { Emulator, EmulatorResult } from "./index.ts";

const wasmPath = join(import.meta.dir, "../../shared/ghostty/ghostty-vt.wasm");
const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** a loader that counts its reads and keeps every module it made */
function countingLoader() {
  const state = { reads: 0, modules: [] as GhosttyModule[] };
  const loader = createEmulatorLoader({
    read: async () => {
      state.reads++;
      return Bun.file(wasmPath).arrayBuffer();
    },
    onModule: (module) => state.modules.push(module),
  });
  return { loader, state };
}

/** the emulator a created result holds, or a failed test */
function made(result: EmulatorResult<Emulator>): Emulator {
  if (!result.ok) throw new Error(`no emulator: ${result.error.kind}: ${result.error.message}`);
  return result.value;
}

/** what an emulator draws on row `y`, trailing blanks cut */
function rowText(emulator: Emulator, y: number): string {
  let found = "";
  const result = emulator.frameAll((row, runs) => {
    if (row === y) found = runs.flatMap((run) => run.cells.map((cell) => cell.text)).join("").trimEnd();
  }, "written");
  expect(result.ok).toBe(true);
  return found;
}

/** an emulator with its replies collected */
async function pane(loader: ReturnType<typeof countingLoader>["loader"], cols = 20, rows = 5) {
  const replies: string[] = [];
  const emulator = made(await loader.create({ cols, rows, events: { onReply: (bytes) => replies.push(text(bytes)) } }));
  return { emulator, replies };
}

describe("emulator per pane", () => {
  it("shares no state between two emulators", async () => {
    const { loader } = countingLoader();
    const a = await pane(loader);
    const b = await pane(loader);
    a.emulator.write(bytesOf("alpha"));
    b.emulator.write(bytesOf("beta\r\n\x1b[6n"));
    expect(rowText(a.emulator, 0)).toBe("alpha");
    expect(rowText(b.emulator, 0)).toBe("beta");
    expect(rowText(a.emulator, 1)).toBe("");
    expect(a.replies).toEqual([]);
    expect(b.replies).toEqual(["\x1b[2;1R"]);
    a.emulator.write(bytesOf("\x1b[6n"));
    expect(a.replies).toEqual(["\x1b[1;6R"]);
    expect(b.replies).toEqual(["\x1b[2;1R"]);
  });

  it("asks the engine for the core's width rule, no images and the shared history line", async () => {
    const { loader } = countingLoader();
    const { emulator, replies } = await pane(loader, 20, 3);
    // a ZWJ family is one wide cell under the core's rule (two columns), six under xterm's
    emulator.write(bytesOf("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}x\x1b[6n"));
    expect(replies).toEqual(["\x1b[1;4R"]);
    replies.length = 0;
    emulator.write(bytesOf("\x1b_Gi=1,a=q;AAAA\x1b\\"));
    expect(replies).toEqual([]);
    emulator.write(bytesOf("\x1b[2J\x1b[H" + "line\r\n".repeat(TERMINAL_HISTORY_LINES + 200)));
    const history = emulator.history();
    expect(history.ok && history.value.scrollback).toBeGreaterThanOrEqual(TERMINAL_HISTORY_LINES * 0.75);
  });

  it("frees on dispose and reports the error value afterwards", async () => {
    const { loader, state } = countingLoader();
    const { emulator, replies } = await pane(loader);
    emulator.write(bytesOf("x"));
    emulator.dispose();
    emulator.dispose();
    const after = emulator.write(bytesOf("\x1b[6n"));
    expect(after.ok).toBe(false);
    expect(!after.ok && after.error.kind).toBe("disposed");
    for (const result of [emulator.resize(30, 6, 8, 16), emulator.frameAll(() => {}), emulator.cursorState(), emulator.encodePaste("a")]) {
      expect(!result.ok && result.error.kind).toBe("disposed");
    }
    expect(replies).toEqual([]);

    const first = state.modules.length;
    for (let round = 0; round < 200; round++) {
      const next = await pane(loader);
      next.emulator.write(bytesOf("round\x1b[6n"));
      next.emulator.dispose();
    }
    const sizes = state.modules.slice(first).map((module) => module.exports.memory.buffer.byteLength);
    expect(sizes).toHaveLength(200);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(sizes[0]! * 2);
  }, 60_000);

  it("keeps a second emulator answering after the first one's engine throws", async () => {
    let armed = false;
    const modules: GhosttyModule[] = [];
    const loader = createEmulatorLoader({
      read: async () => Bun.file(wasmPath).arrayBuffer(),
      onModule: (module) => {
        modules.push(module);
        // a copy of the exports whose write can be made to trap, as a real out-of-bounds write does
        const real = module.exports;
        const first = modules.length === 1;
        const forced: GhosttyExports = { ...real, ghostty_terminal_vt_write: (terminal, ptr, len) => {
          if (first && armed) throw new WebAssembly.RuntimeError("forced: memory access out of bounds");
          return real.ghostty_terminal_vt_write(terminal, ptr, len);
        } };
        (module as { exports: GhosttyExports }).exports = forced;
      },
    });
    const a = await pane(loader);
    const b = await pane(loader);
    armed = true;
    const failed = a.emulator.write(bytesOf("boom"));
    expect(!failed.ok && failed.error.kind).toBe("trapped");
    const again = a.emulator.write(bytesOf("later"));
    expect(!again.ok && again.error.kind).toBe("trapped");
    expect(a.emulator.failure?.kind).toBe("trapped");

    expect(b.emulator.write(bytesOf("alive\x1b[6n")).ok).toBe(true);
    expect(b.replies).toEqual(["\x1b[1;6R"]);
    expect(rowText(b.emulator, 0)).toBe("alive");

    // the dead emulator's module is not reused: a new emulator gets a module of its own
    armed = false;
    const c = await pane(loader);
    expect(modules).toHaveLength(3);
    expect(modules[2]).not.toBe(modules[0]);
    c.emulator.write(bytesOf("\x1b[6n"));
    expect(c.replies).toEqual(["\x1b[1;1R"]);
    a.emulator.dispose();
  });

  it("reports an error thrown by the caller's handler as an error value", async () => {
    const { loader } = countingLoader();
    const emulator = made(await loader.create({ cols: 10, rows: 3, events: { onReply: () => { throw new Error("handler broke"); } } }));
    const result = emulator.write(bytesOf("\x1b[6n"));
    expect(!result.ok && result.error.kind).toBe("failed");
    expect(!result.ok && result.error.message).toContain("handler broke");
  });

  it("refuses a size outside the range before the engine sees it", async () => {
    const { loader } = countingLoader();
    const { emulator, replies } = await pane(loader);
    const sizes: [number, number, number, number][] = [
      [0, 5, 8, 16], [5, 0, 8, 16], [-1, -1, 8, 16], [65535, 65535, 8, 16], [MAX_COLS + 1, 5, 8, 16],
      [5, MAX_ROWS + 1, 8, 16], [1.5, 5, 8, 16], [Number.NaN, 5, 8, 16], [5, 5, Number.NaN, 16], [5, 5, Number.POSITIVE_INFINITY, 16],
    ];
    for (const [cols, rows, cellW, cellH] of sizes) {
      const result = emulator.resize(cols, rows, cellW, cellH);
      expect(!result.ok && result.error.kind).toBe("size");
    }
    for (const [cols, rows] of [[0, 0], [-1, -1], [65535, 65535]] as const) {
      const created = await loader.create({ cols, rows, events: {} });
      expect(!created.ok && created.error.kind).toBe("size");
    }
    expect(emulator.failure).toBeNull();
    expect(emulator.resize(MAX_COLS, MAX_ROWS, 8, 16).ok).toBe(true);
    expect(emulator.resize(1, 1, 8, 16).ok).toBe(true);
    emulator.write(bytesOf("\x1b[6n"));
    expect(replies).toEqual(["\x1b[1;1R"]);
  });

  it("takes a megabyte of random bytes without an exception", async () => {
    const { loader } = countingLoader();
    const { emulator } = await pane(loader, 80, 24);
    const chunk = new Uint8Array(65536);
    for (let sent = 0; sent < 1 << 20; sent += chunk.length) {
      crypto.getRandomValues(chunk);
      const result = emulator.write(chunk);
      if (!result.ok) {
        expect(["trapped", "failed"]).toContain(result.error.kind);
        break;
      }
    }
    expect(() => emulator.frameAll(() => {})).not.toThrow();
  }, 60_000);
});

describe("the engine file", () => {
  it("is read once, on the first emulator, and not before", async () => {
    const { loader, state } = countingLoader();
    expect(state.reads).toBe(0);
    await pane(loader);
    expect(state.reads).toBe(1);
    await Promise.all([pane(loader), pane(loader)]);
    await pane(loader);
    expect(state.reads).toBe(1);
  });

  it("is not read by importing the loader, and a missing file is an error value that a later call retries", async () => {
    // the default loader reads the embedded file only when it is asked for an emulator
    expect(typeof createEmulator).toBe("function");
    let reads = 0;
    let exists = false;
    const loader = createEmulatorLoader({
      read: async () => {
        reads++;
        if (!exists) throw new Error("ENOENT: not there yet");
        return Bun.file(wasmPath).arrayBuffer();
      },
    });
    expect(reads).toBe(0);
    const missing = await loader.create({ cols: 10, rows: 3, events: {} });
    expect(!missing.ok && missing.error.kind).toBe("failed");
    exists = true;
    made(await loader.create({ cols: 10, rows: 3, events: {} })).dispose();
    expect(reads).toBe(2);
  });
});
