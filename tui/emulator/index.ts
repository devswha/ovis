import type {
  ColorForm,
  EngineColors,
  EngineCursor,
  EngineEvents,
  EngineHistory,
  EngineKey,
  EngineModes,
  EngineMouse,
  GhosttyRun,
  ScreenPoint,
  ScreenRange,
  WrittenColor,
} from "../../shared/ghostty/engine.ts";

export type { EngineColors, EngineCursor, EngineEvents, EngineHistory, EngineKey, EngineModes, EngineMouse, GhosttyRun, ScreenPoint, ScreenRange, WrittenColor };

/**
 * Why a call gave no answer:
 * - `size`: a size outside the range, refused before the engine saw it; the emulator is as it was.
 * - `disposed`: the emulator was disposed.
 * - `trapped`: the engine's module trapped (a `WebAssembly.RuntimeError`); the emulator is dead.
 * - `failed`: the engine, or a handler passed in `events`, threw; the emulator is dead.
 * A dead emulator answers every later call with the same error: the pane machine makes a new one by reattaching.
 */
export interface EmulatorError {
  kind: "size" | "disposed" | "trapped" | "failed";
  message: string;
  cause?: unknown;
}

/** What every call of an emulator returns: nothing it does throws into the caller. */
export type EmulatorResult<T> = { ok: true; value: T } | { ok: false; error: EmulatorError };

export interface EmulatorOptions {
  cols: number;
  rows: number;
  /** replies, holds and effects of this pane; an empty object when the caller wants none */
  events: EngineEvents;
}

/** One pane's terminal state. Not shared: its own wasm instance, freed by `dispose`. */
export interface Emulator {
  /** the error that killed this emulator, or null while it lives (a refused size leaves it null) */
  readonly failure: EmulatorError | null;

  write(bytes: Uint8Array): EmulatorResult<void>;
  /** a no-op when nothing changed; cell sizes are in pixels */
  resize(cols: number, rows: number, cellW: number, cellH: number): EmulatorResult<void>;
  reset(): EmulatorResult<void>;
  /** frees the terminal; safe to call twice and on a dead emulator, and it cannot fail */
  dispose(): void;

  /** rows changed since the last call, as runs of cells that share a style; true when any row was drawn */
  frame<F extends ColorForm = "hex">(draw: (y: number, runs: GhosttyRun<F extends "written" ? WrittenColor : string>[]) => void, colors?: F): EmulatorResult<boolean>;
  frameAll<F extends ColorForm = "hex">(draw: (y: number, runs: GhosttyRun<F extends "written" ? WrittenColor : string>[]) => void, colors?: F): EmulatorResult<void>;
  /** the cursor of the last frame; draw first */
  cursorState(): EmulatorResult<EngineCursor>;
  modes(): EmulatorResult<EngineModes>;
  setMode(mode: number, on: boolean): EmulatorResult<void>;
  releaseHold(): EmulatorResult<void>;
  setColors(colors: EngineColors): EmulatorResult<void>;

  /** empty bytes: the program cannot see the key */
  encodeKey(key: EngineKey): EmulatorResult<Uint8Array>;
  /** empty bytes: the program asked for no mouse */
  encodeMouse(mouse: EngineMouse): EmulatorResult<Uint8Array>;
  encodePaste(text: string): EmulatorResult<Uint8Array>;

  setScrollback(lines: number): EmulatorResult<void>;
  scrollFromBottom(rowsAboveBottom: number): EmulatorResult<void>;
  history(): EmulatorResult<EngineHistory>;
  textOf(range: ScreenRange): EmulatorResult<string>;
  wordAt(point: ScreenPoint): EmulatorResult<ScreenRange | null>;
  lineAt(point: ScreenPoint): EmulatorResult<ScreenRange | null>;
  search(needle: string): EmulatorResult<ScreenRange[]>;
  searchStep(toward: "older" | "newer"): EmulatorResult<ScreenRange | null>;
}

/** Makes emulators, one per pane. */
export interface EmulatorLoader {
  create(options: EmulatorOptions): Promise<EmulatorResult<Emulator>>;
}
