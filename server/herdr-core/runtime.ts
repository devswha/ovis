import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startHerdrCoreAdapter, type HerdrCoreAdapter } from "./adapter.ts";
import { HcConnection, spawnHcConnect } from "./connection.ts";

/**
 * Which runtime this PC's terminals run on. `OVIS_RUNTIME=herdr-core` serves the terminals of
 * herdr-core (`hc`), the core the Herdr desktop app runs on, in place of herdr's TUI server; unset,
 * or `herdr`, keeps herdr. Read once per process: a server does not change runtime while it runs.
 */
export type Runtime = "herdr" | "herdr-core";

export function runtime(): Runtime {
  const value = process.env["OVIS_RUNTIME"];
  if (value === undefined || value === "" || value === "herdr") return "herdr";
  if (value === "herdr-core") return "herdr-core";
  throw new Error(`OVIS_RUNTIME=${value} is not a runtime Ovis knows: use herdr (the default) or herdr-core`);
}

/** The `hc` to run: OVIS_HC_BIN, else `hc` on the PATH. */
export function hcBin(): string {
  return process.env["OVIS_HC_BIN"] || "hc";
}

/**
 * On herdr-core, the adapter that answers herdr's API from hc (server/herdr-core/adapter.ts),
 * listening in the state folder, and HERDR_SOCKET pointed at it before anything reads it; on
 * herdr, nothing.
 */
export function startRuntime(stateDir: string): HerdrCoreAdapter | null {
  if (runtime() !== "herdr-core") return null;
  // the state folder is otherwise created on first write: the socket goes there first
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const hc = new HcConnection(() => spawnHcConnect(hcBin()));
  const adapter = startHerdrCoreAdapter(hc, join(stateDir, "herdr-core.sock"));
  process.env["HERDR_SOCKET"] = adapter.socketPath;
  return {
    socketPath: adapter.socketPath,
    stop: () => {
      adapter.stop();
      hc.close();
    },
  };
}
