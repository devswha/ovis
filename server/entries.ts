/**
 * The server's entry points by name. From source each is its own file that Bun runs; in the compiled
 * binary (scripts/build-server.ts) all of them are one file, `ovis-server <name>` (server/main.ts).
 * Every child process this server starts from its own code is started through entryCommand.
 */
import { dirname, join } from "node:path";

export const ENTRIES = {
  serve: { file: "server/index.ts", run: () => import("./index.ts").then((entry) => entry.serve()) },
  managed: { file: "server/managed.ts", run: () => import("./managed.ts").then((entry) => entry.runManaged()) },
  supervisor: { file: "server/supervisor.ts", run: () => import("./supervisor.ts").then((entry) => entry.runSupervisor(process.env["OVIS_SOURCE_ROOT"] || ROOT)) },
  remote: { file: "server/remote-entry.ts", run: () => import("./remote-entry.ts") },
  machine: { file: "server/herdr-core/machine-entry.ts", run: () => import("./herdr-core/machine-entry.ts") },
  plugin: { file: "scripts/plugin.ts", run: () => import("../scripts/plugin.ts").then((entry) => entry.runPlugin()) },
  askpass: { file: "server/ssh-askpass.ts", run: () => import("./ssh-askpass.ts") },
  "windows-launch": { file: "server/windows-launch.ts", run: () => import("./windows-launch.ts") },
} as const;

export type EntryName = keyof typeof ENTRIES;

/** Whether this process is the compiled binary: its modules then live in Bun's embedded file system. */
export const COMPILED = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(import.meta.path);

/** The checkout when run from source; the binary's own folder when compiled. */
export function serverRoot(compiled = COMPILED): string {
  return compiled ? dirname(process.execPath) : join(import.meta.dir, "..");
}
export const ROOT = serverRoot();

/** Where `dist/` is read from: OVIS_ASSETS when set, else the server's root. */
export function assetsRoot(env: Record<string, string | undefined> = process.env, root = ROOT): string {
  return env["OVIS_ASSETS"] || root;
}
export const ASSETS = assetsRoot();

/**
 * The environment that makes process.execPath run as Bun itself (`-e`, a script file): the compiled
 * binary is Bun only with BUN_BE_BUN set; from source process.execPath already is Bun.
 */
export const BUN_ENV: Record<string, string> = COMPILED ? { BUN_BE_BUN: "1" } : {};

/** The command that starts entry `name`: its file under `root` from source, the binary with the entry's name when compiled. */
export function entryCommand(name: EntryName, root = ROOT, compiled = COMPILED): [string, string] {
  return [process.execPath, compiled ? name : join(root, ENTRIES[name].file)];
}
