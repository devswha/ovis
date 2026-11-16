import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
  ENGINE_ENUMS,
  ENGINE_FIELDS,
  ENGINE_FUNCTIONS,
  GhosttyEngine,
  GhosttyModule,
  readTypeLayout,
  type EngineEffect,
  type EngineOptions,
  type GhosttyExports,
  type GhosttyRun,
  type WrittenColor,
} from "./engine.ts";

const repo = join(import.meta.dir, "../..");
const wasmPath = join(import.meta.dir, "ghostty-vt.wasm");
/** the file the digest case checks: OVIS_GHOSTTY_WASM points it at another copy */
const checkedWasmPath = process.env.OVIS_GHOSTTY_WASM || wasmPath;

const wasm = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
const instantiate = (): WebAssembly.Instance => new WebAssembly.Instance(wasm, {});
/** the module the cases share unless one makes its own; the screen itself keeps one module per pane */
const shared = new GhosttyModule(instantiate());

const rowText = (runs: GhosttyRun<unknown>[]): string => runs.flatMap((run) => run.cells.map((cell) => cell.text)).join("").trimEnd();
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);

/** an engine as the screen makes it, with everything it reports collected */
function screenEngine(cols: number, rows: number, options: Partial<EngineOptions> = {}, module = shared) {
  const replies: string[] = [];
  const holds: boolean[] = [];
  const effects: EngineEffect[] = [];
  const engine = new GhosttyEngine(module, cols, rows, {
    widths: "core",
    images: false,
    events: { onReply: (bytes) => replies.push(text(bytes)), onHold: (held) => holds.push(held), onEffect: (effect) => effects.push(effect) },
    ...options,
  });
  return { engine, replies, holds, effects };
}

/** every row as frameAll draws it, in the colours the program wrote */
function screenRows(engine: GhosttyEngine): Map<number, GhosttyRun<WrittenColor>[]> {
  const rows = new Map<number, GhosttyRun<WrittenColor>[]>();
  engine.frameAll((y, runs) => rows.set(y, runs), "written");
  return rows;
}

describe("shared/ghostty engine", () => {
  it("engine exports", () => {
    const exported = new Map(WebAssembly.Module.exports(wasm).map((entry) => [entry.name, entry.kind]));
    expect(Object.keys(ENGINE_FUNCTIONS).filter((name) => exported.get(name) !== "function")).toEqual([]);
    expect(exported.get("__indirect_function_table")).toBe("table");
    const layout = readTypeLayout(instantiate().exports as unknown as GhosttyExports);
    const unresolved = [
      ...Object.entries(ENGINE_ENUMS).flatMap(([type, names]) =>
        names.filter((name) => layout.types[type]?.values?.[name] === undefined).map((name) => `${type}.${name}`)),
      ...Object.entries(ENGINE_FIELDS).flatMap(([type, names]) =>
        names.filter((name) => layout.types[type]?.fields?.[name] === undefined).map((name) => `${type}.${name}`)),
    ];
    expect(unresolved).toEqual([]);
  });

  it("engine wasm is the build script's expected output", async () => {
    const script = await Bun.file(join(repo, "scripts/ghostty-vt/build.sh")).text();
    const expected = /^# Expected output sha256.*\n#\s+([0-9a-f]{64})$/m.exec(script)?.[1];
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(checkedWasmPath).arrayBuffer()).digest("hex");
    expect(actual).toBe(expected!);
  });

  it("engine draws what was written", () => {
    const engine = new GhosttyEngine(new GhosttyModule(instantiate()), 20, 4, { widths: "xterm", images: false });
    try {
      engine.write(bytesOf("hello"));
      const rows = new Map<number, string>();
      expect(engine.frame((y, runs) => rows.set(y, rowText(runs)))).toBe(true);
      expect(rows.get(0)).toBe("hello");
      expect(engine.cursor()).toEqual({ visible: true, x: 5, y: 0, style: 1 });
    } finally {
      engine.dispose();
    }
  });

  it("engine names a type name the module does not have", () => {
    const exports = new GhosttyModule(instantiate()).exports;
    const layout = readTypeLayout(exports);
    delete layout.types["GhosttyTerminalOption"]!.values!["SCROLLBACK_MAX_LINES"];
    const json = new TextEncoder().encode(`${JSON.stringify(layout)}\0`);
    const ptr = exports.ghostty_wasm_alloc(json.length);
    new Uint8Array(exports.memory.buffer, ptr, json.length).set(json);
    expect(() => new GhosttyModule({ ...exports, ghostty_type_json: () => ptr })).toThrow("GhosttyTerminalOption.SCROLLBACK_MAX_LINES");
  });

  it("engine split feed", () => {
    const stream = bytesOf([
      "\x1b]0;title\x07\x1b[31mred\x1b[0m \x1b[38;5;196mx\x1b[48;2;10;20;30my\x1b[0m\r\n",
      "한글 👨‍👩‍👧 e\u0301\r\n",
      "\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[>1u\x1b[?9001h\x1b[5 q\x1b[42m\x1b[K\x1b[0m\r\n",
      "wrapping text past the edge\x1b[2;2H",
    ].join(""));
    const snapshot = (...chunks: Uint8Array[]): string => {
      const { engine } = screenEngine(20, 6);
      try {
        for (const chunk of chunks) engine.write(chunk);
        return JSON.stringify({ rows: [...screenRows(engine)], cursor: engine.cursorState(), modes: engine.modes() });
      } finally {
        engine.dispose();
      }
    };
    const whole = snapshot(stream);
    for (let cut = 1; cut < stream.length; cut++) expect(snapshot(stream.subarray(0, cut), stream.subarray(cut))).toBe(whole);
    expect(snapshot(...Array.from(stream, (byte) => Uint8Array.of(byte)))).toBe(whole);

    const { engine } = screenEngine(20, 6);
    try {
      engine.write(stream);
      const rows = screenRows(engine);
      const first = rows.get(0)!;
      expect(first.map((run) => [run.x, run.cells.map((cell) => cell.text).join(""), run.fg, run.bg])).toEqual([
        [0, "red", 1, null], [3, " ", null, null], [4, "x", 196, null], [5, "y", 196, [10, 20, 30]], [6, " ".repeat(14), null, null],
      ]);
      const second = rows.get(1)!.flatMap((run) => run.cells);
      expect(second.slice(0, 6)).toEqual([
        { text: "한", wide: true }, { text: "글", wide: true }, { text: " ", wide: false },
        { text: "👨‍👩‍👧", wide: true }, { text: " ", wide: false }, { text: "e\u0301", wide: false },
      ]);
      expect(rows.get(2)).toEqual([{ x: 0, cells: Array(20).fill({ text: " ", wide: false }), fg: null, bg: 2, flags: 0 }]);
      expect(rowText(rows.get(3)!)).toBe("wrapping text past t");
      expect(rowText(rows.get(4)!)).toBe("he edge");
      expect(engine.cursorState()).toEqual({ visible: true, x: 1, y: 1, style: "bar", blinking: true, wideTail: true });
      expect(engine.modes()).toEqual({
        altScreen: false, mouse: "button", mouseFormat: "sgr", bracketedPaste: true, kittyFlags: 1, focusReports: false,
        syncOutput: false, appCursor: false, appKeypad: false, altScroll: true, win32Input: true,
      });
    } finally {
      engine.dispose();
    }
  });

  it("engine replies only through onReply", () => {
    const { engine, replies } = screenEngine(80, 24);
    try {
      engine.write(bytesOf("\x1b[6n"));
      expect(replies).toEqual(["\x1b[1;1R"]);
      engine.write(bytesOf("\x1b[?1000h\x1b[?1006h\x1b[?2004h"));
      expect(text(engine.encodeKey({ key: "A", text: "a", unshifted: "a" }))).toBe("a");
      expect(text(engine.encodeMouse({ action: "press", button: "left", col: 0, row: 0 }))).toBe("\x1b[<0;1;1M");
      expect(text(engine.encodePaste("one\ntwo\nthree"))).toBe("\x1b[200~one\ntwo\nthree\x1b[201~");
      expect(replies).toEqual(["\x1b[1;1R"]);
    } finally {
      engine.dispose();
    }
  });

  it("engine effects", () => {
    const { engine, replies, effects } = screenEngine(20, 4);
    try {
      engine.write(bytesOf("\x07\x1b]52;c;aGVsbG8=\x07\x1b]52;c;?\x07"));
      expect(effects).toEqual([
        { type: "bell" },
        { type: "clipboardWrite", location: "standard", contents: [{ mime: "text/plain", data: bytesOf("hello") }] },
      ]);
      expect(replies).toEqual([]);
    } finally {
      engine.dispose();
    }
  });

  it("engine key table", () => {
    const table: [setup: string, key: Parameters<GhosttyEngine["encodeKey"]>[0], bytes: string][] = [
      ["", { key: "C", mods: { ctrl: true }, text: "c", unshifted: "c" }, "\x03"],
      ["", { key: "A", mods: { alt: true }, text: "a", unshifted: "a" }, "\x1ba"],
      ["", { key: "TAB", mods: { shift: true } }, "\x1b[Z"],
      ["", { key: "TAB", text: "\t" }, "\t"],
      ["", { key: "ENTER", text: "\r" }, "\r"],
      ["", { key: "I", mods: { ctrl: true }, text: "i", unshifted: "i" }, "\t"],
      ["", { key: "M", mods: { ctrl: true }, text: "m", unshifted: "m" }, "\r"],
      ["", { key: "A", mods: { ctrl: true, shift: true }, text: "A", unshifted: "a" }, "\x01"],
      ["", { key: "A", text: "한" }, "한"],
      ["", { key: "ARROW_UP" }, "\x1b[A"],
      ["", { key: "BACKSPACE" }, "\x7f"],
      ["", { key: "ESCAPE" }, "\x1b"],
      ["", { key: "SHIFT_LEFT", mods: { shift: true } }, ""],
      ["", { key: "A", text: "a", unshifted: "a", action: "release" }, ""],
      ["\x1b[?1h", { key: "ARROW_UP" }, "\x1bOA"],
      ["\x1b[>1u", { key: "A", mods: { ctrl: true, shift: true }, text: "A", unshifted: "a" }, "\x1b[97;6u"],
      ["\x1b[>1u", { key: "I", mods: { ctrl: true }, text: "i", unshifted: "i" }, "\x1b[105;5u"],
      ["\x1b[>1u", { key: "ESCAPE" }, "\x1b[27u"],
      ["\x1b[>4;2m", { key: "I", mods: { ctrl: true }, text: "i", unshifted: "i" }, "\x1b[27;5;105~"],
    ];
    const rows = table.map(([setup, key]) => {
      const { engine } = screenEngine(80, 24);
      try {
        engine.write(bytesOf(setup));
        return [setup, key, text(engine.encodeKey(key))];
      } finally {
        engine.dispose();
      }
    });
    expect(rows).toEqual(table);
  });

  it("engine mouse follows the program", () => {
    const { engine, replies } = screenEngine(80, 24);
    try {
      expect(text(engine.encodeMouse({ action: "press", button: "left", col: 3, row: 2 }))).toBe("");
      engine.write(bytesOf("\x1b[?1002h\x1b[?1006h"));
      expect(engine.modes()).toMatchObject({ mouse: "button", mouseFormat: "sgr" });
      expect(text(engine.encodeMouse({ action: "press", button: "left", col: 3, row: 2 }))).toBe("\x1b[<0;4;3M");
      expect(text(engine.encodeMouse({ action: "motion", button: "left", col: 5, row: 2 }))).toBe("\x1b[<32;6;3M");
      expect(text(engine.encodeMouse({ action: "release", button: "left", col: 5, row: 2 }))).toBe("\x1b[<0;6;3m");
      expect(text(engine.encodeMouse({ action: "motion", col: 7, row: 2 }))).toBe("");
      expect(text(engine.encodeMouse({ action: "press", button: "wheelUp", mods: { ctrl: true }, col: 0, row: 0 }))).toBe("\x1b[<80;1;1M");
      engine.write(bytesOf("\x1b[?1002l\x1b[?1006l"));
      expect(engine.modes()).toMatchObject({ mouse: "none", mouseFormat: "x10" });
      expect(text(engine.encodeMouse({ action: "press", button: "left", col: 3, row: 2 }))).toBe("");
      expect(replies).toEqual([]);
    } finally {
      engine.dispose();
    }
  });

  it("engine paste", () => {
    const { engine } = screenEngine(80, 24);
    try {
      expect(text(engine.encodePaste("one\ntwo\n\nthree"))).toBe("one\rtwo\r\rthree");
      engine.write(bytesOf("\x1b[?2004h"));
      expect(text(engine.encodePaste("a\x1b[201~b"))).toBe("\x1b[200~a [201~b\x1b[201~");
      expect(text(engine.encodePaste("one\ntwo\nthree"))).toBe("\x1b[200~one\ntwo\nthree\x1b[201~");
      expect(text(engine.encodePaste(""))).toBe("\x1b[200~\x1b[201~");
    } finally {
      engine.dispose();
    }
  });

  it("engine hold", () => {
    const { engine, holds } = screenEngine(20, 3);
    const firstRow = (): string => rowText(screenRows(engine).get(0)!);
    try {
      engine.write(bytesOf("A"));
      expect(firstRow()).toBe("A");
      engine.write(bytesOf("B\x1b[?2026hC"));
      expect(holds).toEqual([true]);
      expect(firstRow()).toBe("AB");
      engine.write(bytesOf("\x1b[?2026h"));
      expect(holds).toEqual([true]);
      expect(engine.frame(() => {})).toBe(false);
      engine.write(bytesOf("\x1b[?2026l"));
      expect(holds).toEqual([true, false]);
      expect(firstRow()).toBe("ABC");
      engine.write(bytesOf("\x1b[?2026hD"));
      expect(firstRow()).toBe("ABC");
      expect(engine.modes().syncOutput).toBe(true);
      engine.releaseHold();
      expect(holds).toEqual([true, false, true, false]);
      expect(engine.modes().syncOutput).toBe(false);
      expect(firstRow()).toBe("ABCD");
      engine.write(bytesOf("\x1b[?2026l"));
      engine.releaseHold();
      expect(holds).toEqual([true, false, true, false]);
    } finally {
      engine.dispose();
    }
  });

  it("engine core widths", () => {
    const family = bytesOf("ABC👨‍👩‍👧XYZ");
    const cursorAfter = (widths: EngineOptions["widths"]): number[] => {
      const { engine } = screenEngine(40, 2, { widths });
      try {
        engine.write(family);
        engine.frame(() => {});
        const before = engine.cursorState().x;
        engine.reset();
        engine.write(family);
        engine.frame(() => {});
        return [before, engine.cursorState().x];
      } finally {
        engine.dispose();
      }
    };
    expect(cursorAfter("core")).toEqual([8, 8]);
    expect(cursorAfter("xterm")).toEqual([12, 12]);
  });

  it("engine same-size resize", () => {
    const { engine, replies } = screenEngine(80, 24);
    try {
      engine.resize(80, 24, 8, 16);
      engine.write(bytesOf("\x1b[?2048h"));
      expect(replies).toEqual(["\x1b[48;24;80;384;640t"]);
      engine.resize(80, 24, 8, 16);
      engine.resize(80, 24, 8.2, 15.8);
      expect(replies).toEqual(["\x1b[48;24;80;384;640t"]);
      engine.resize(100, 30, 8, 16);
      expect(replies).toEqual(["\x1b[48;24;80;384;640t", "\x1b[48;30;100;480;800t"]);
    } finally {
      engine.dispose();
    }
  });

  it("engine images off", () => {
    const query = bytesOf("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\");
    const off = screenEngine(20, 4);
    const on = screenEngine(20, 4, { images: 1024n * 1024n });
    try {
      off.engine.write(query);
      on.engine.write(query);
      expect(off.replies).toEqual([]);
      expect(on.replies).toEqual(["\x1b_Gi=31;OK\x1b\\"]);
    } finally {
      off.engine.dispose();
      on.engine.dispose();
    }
  });

  it("engine 9001", () => {
    const { engine } = screenEngine(20, 4);
    try {
      expect(engine.modes().win32Input).toBe(false);
      engine.write(bytesOf("\x1b[?90"));
      engine.write(bytesOf("01h"));
      expect(engine.modes().win32Input).toBe(true);
      engine.write(bytesOf("\x1b[?9001l"));
      expect(engine.modes().win32Input).toBe(false);
      engine.write(bytesOf("\x1b[?1;9001h"));
      expect(engine.modes().win32Input).toBe(true);
      engine.write(bytesOf("\x1b[?9001;1"));
      engine.write(bytesOf("l"));
      expect(engine.modes().win32Input).toBe(false);
      engine.write(bytesOf("\x1b[?9001h\x1bc"));
      expect(engine.modes().win32Input).toBe(false);
      engine.write(bytesOf("\x1b[9001h\x1b[?19001h"));
      expect(engine.modes().win32Input).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it("engine history", () => {
    const { engine } = screenEngine(80, 6, { scrollbackLines: 1000 });
    try {
      engine.write(bytesOf(Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, "0")} end`).join("\r\n")));
      expect(engine.history()).toEqual({ scrollback: 34, total: 40, viewportTop: 34 });
      expect(engine.textOf({ start: { x: 0, y: 0 }, end: { x: 79, y: 1 } })).toBe("line 00 end\nline 01 end");
      expect(engine.lineAt({ x: 3, y: 39 })).toEqual({ start: { x: 0, y: 39 }, end: { x: 10, y: 39 } });
      expect(engine.wordAt({ x: 6, y: 7 })).toEqual({ start: { x: 5, y: 7 }, end: { x: 6, y: 7 } });
      expect(engine.search("line 07")).toEqual([{ start: { x: 0, y: 7 }, end: { x: 6, y: 7 } }]);
      expect(engine.searchStep("older")).toEqual({ start: { x: 0, y: 7 }, end: { x: 6, y: 7 } });
      const scrolled = engine.history().viewportTop;
      expect(scrolled).toBeLessThanOrEqual(7);
      expect(rowText(screenRows(engine).get(7 - scrolled)!)).toBe("line 07 end");
      expect(engine.search("absent")).toEqual([]);
      expect(engine.searchStep("newer")).toBeNull();
      engine.scrollFromBottom(0);
      expect(engine.history().viewportTop).toBe(34);
    } finally {
      engine.dispose();
    }
    // 6000 lines of 107 columns: past 2000 the kept rows move between about 1623 and 1998 as whole pages are
    // dropped; with the module's byte limit on, about 600 stay whatever the line limit says
    const lines = bytesOf(Array.from({ length: 6000 }, (_, i) => `H${String(i).padStart(5, "0")} ${"x".repeat(100)}\r\n`).join(""));
    const keptRows = (engine: GhosttyEngine): number => {
      try {
        engine.write(lines);
        return engine.history().scrollback;
      } finally {
        engine.dispose();
      }
    };
    expect(keptRows(screenEngine(120, 40, { scrollbackLines: 2000 }).engine)).toBeGreaterThan(1500);
    const changedLater = screenEngine(120, 40, { scrollbackLines: 500 }).engine;
    changedLater.setScrollback(2000);
    expect(keptRows(changedLater)).toBeGreaterThan(1500);
    const browsers = new GhosttyEngine(shared, 120, 40, { widths: "xterm", images: false });
    browsers.setScrollback(2000);
    expect(keptRows(browsers)).toBeLessThan(1000);
  });

  it("engine refuses every call after a trap in its module", () => {
    const exports = instantiate().exports as unknown as GhosttyExports;
    const module = new GhosttyModule({ ...exports, ghostty_terminal_vt_write: () => { throw new WebAssembly.RuntimeError("unreachable"); } });
    const first = screenEngine(20, 4, {}, module);
    const second = screenEngine(20, 4, {}, module);
    const thrown = (run: () => unknown): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return null;
    };
    const trap = thrown(() => first.engine.write(bytesOf("x")));
    expect(trap).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(module.trap).toBe(trap as WebAssembly.RuntimeError);
    for (const refusal of [
      thrown(() => first.engine.modes()),
      thrown(() => second.engine.encodePaste("x")),
      thrown(() => new GhosttyEngine(module, 20, 4, { widths: "core", images: false })),
    ]) {
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).not.toBeInstanceOf(WebAssembly.RuntimeError);
      expect((refusal as Error).cause).toBe(trap);
    }

    // the browser's engines record no trap: the module they share stays usable for the page's other terminals
    const trapping = (): never => { throw new WebAssembly.RuntimeError("unreachable"); };
    const browsers = new GhosttyModule({ ...exports, ghostty_terminal_vt_write: trapping, ghostty_terminal_resize: trapping });
    const failing = new GhosttyEngine(browsers, 20, 4, { widths: "xterm", images: false });
    const other = new GhosttyEngine(browsers, 20, 4, { widths: "xterm", images: false });
    expect(thrown(() => failing.write(bytesOf("x")))).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(thrown(() => failing.resize(30, 5, 8, 16))).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(browsers.trap).toBeNull();
    other.setColors({ foreground: [1, 2, 3], background: null, cursor: null, palette: [] });
    expect(other.frame(() => {})).toBe(true);
    failing.dispose();
    other.dispose();
  });
});
