/**
 * The runtime chosen in Settings, saved as `runtime.json` in the state folder: read by the server
 * as it starts (runtime-choice.ts) and put back by the launcher when a start on it fails
 * (server/supervisor.ts). Files only, so the launcher stays small.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_FILE = "runtime.json";

type Runtime = "herdr" | "herdr-core";

export interface SavedRuntime {
  runtime: Runtime;
  /** the runtime served before this choice: what a start that fails goes back to */
  previous: Runtime | null;
}

/** The choice saved from Settings, or null when there is none or it is not one Ovis knows. */
export function readSavedRuntime(stateDir: string): SavedRuntime | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(stateDir, RUNTIME_FILE), "utf8")); } catch { return null; }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const known = (input: unknown): Runtime | null => input === "herdr" || input === "herdr-core" ? input : null;
  const runtime = known(record["runtime"]);
  return runtime === null ? null : { runtime, previous: known(record["previous"]) };
}

/** Saves the choice whole or not at all: a server that starts meanwhile reads the old one or the new. */
export function saveRuntime(stateDir: string, saved: SavedRuntime): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, RUNTIME_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Puts back the runtime served before the saved choice, after a start on it failed; no saved previous one leaves the choice. */
export function restoreRuntime(stateDir: string): void {
  const saved = readSavedRuntime(stateDir);
  if (saved?.previous) saveRuntime(stateDir, { runtime: saved.previous, previous: null });
}

