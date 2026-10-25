/** Where app state and managed-update state live. Dependency-free on purpose: the launcher
 * (server/managed.ts) imports it and must stay small and stable across releases. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

type SupervisorRelease = { readonly root: string; readonly port: number; readonly directory: string };

export function defaultStateDir(env: Record<string, string | undefined> = process.env, supervisor?: SupervisorRelease): string {
  const override = env["OVIS_STATE_DIR"];
  if (override) return override;
  // The launcher chose this supervisor from its active release record. Keep that record's
  // state even when the bridge registry recreated the old name beside it after launcher start.
  if (supervisor) {
    const directory = resolve(supervisor.directory);
    const stateDir = resolve(directory, "../../..");
    if (basename(directory).startsWith("release-") && dirname(directory) === updateStateDir(supervisor.root, supervisor.port, stateDir)) return stateDir;
  }
  const { legacy, next } = stateDirNames(env);
  return currentStateDir(legacy, next);
}

/** The default state dir under its name from before the rename, and under its new one. */
export function stateDirNames(env: Record<string, string | undefined>): { legacy: string; next: string } {
  const config = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return { legacy: join(config, "herdr-web-ui"), next: join(config, "ovis") };
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * The bridge registry (bridge.ts) is kept under the old name for older remote bundles, and every
 * bridge start creates it there again. It is never app state.
 */
const BRIDGE_REGISTRY = "bridges";

/**
 * What the dir under its name from before the rename holds, when it is not the new dir itself:
 * "state", "registry" (the bridge registry alone) or null (nothing of its own).
 */
function legacyContents(legacy: string, next: string): "state" | "registry" | null {
  try {
    if (!isDir(legacy)) return null;
    const entries = readdirSync(legacy);
    if (entries.length === 0 || isDir(next) && realpathSync(legacy) === realpathSync(next)) return null;
    return entries.every((entry) => entry === BRIDGE_REGISTRY) ? "registry" : "state";
  } catch (error) {
    // ENOENT: another process of this install is moving it right now. An old dir this process
    // cannot read is not one it can use; the new one then reports what it cannot write.
    if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** The dir under its name from before the rename, when it still holds state of its own. */
function holdsOwnState(legacy: string, next: string): boolean {
  return legacyContents(legacy, next) === "state";
}

/**
 * Where the state is now; moves nothing. The old dir wins while it holds state of its own: the
 * bridge registry alone is not, or a fresh install would leave its state at its first restart.
 */
export function currentStateDir(legacy: string, next: string): string {
  return holdsOwnState(legacy, next) ? legacy : next;
}

/**
 * A launcher from before 0.4.16 takes an old dir that is not empty for the state, the bridge
 * registry alone included, and an update never replaces a running launcher, nor the one its
 * checkout starts next. So where the old name holds only the registry beside a new dir, the
 * registry moves into the new dir (in one rename: a remote bridge keeps its own state inside it)
 * and the old name becomes a link to the new dir, where those launchers then find the state.
 * A step that fails leaves the rest for the next start, with the registry where it was.
 */
export function linkLegacyRegistry(legacy: string, next: string): void {
  if (legacyContents(legacy, next) !== "registry" || !isDir(next) || lstatSync(legacy).isSymbolicLink()) return;
  const from = join(legacy, BRIDGE_REGISTRY);
  const to = join(next, BRIDGE_REGISTRY);
  let movedWhole = false;
  try {
    if (!existsSync(to)) {
      renameSync(from, to);
      movedWhole = true;
    } else {
      // left by a move that stopped before the link. Bridges register under the old name, so its
      // file is the current one and replaces the other; a dir already there stays as it is
      for (const entry of readdirSync(from)) {
        const target = join(to, entry);
        if (!existsSync(target) || !statSync(target).isDirectory() && !statSync(join(from, entry)).isDirectory()) renameSync(join(from, entry), target);
      }
      rmdirSync(from);
    }
    rmdirSync(legacy);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: another process of this install moved it first, and links it
    if (code === "ENOENT") return;
    if (movedWhole) try { renameSync(to, from); } catch { /* the registry stays in the new dir, unlinked until the next start */ }
    console.error(`cannot link ${legacy} to ${next}, so an Ovis launcher from before 0.4.16 may start on ${legacy}: ${(error as Error).message}`);
    return;
  }
  try {
    symlinkSync(next, legacy, "junction");
  } catch (error) {
    // EEXIST: another process linked it, or a bridge registered again in between (the next start links it)
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") console.error(`moved the bridge registry into ${next} but cannot link ${legacy} to it: ${(error as Error).message}`);
  }
}

let moved = false;

/**
 * Moves the state dir from before the rename to its new name, once per process. Only the
 * processes that own the state call it (launcher, supervisor, server), before they read it;
 * anything else, a test included, only resolves where the state is (defaultStateDir).
 */
export function moveLegacyStateDir(env: Record<string, string | undefined> = process.env, supervisor?: SupervisorRelease): void {
  if (moved) return;
  const { legacy, next } = stateDirNames(env);
  // whichever dir this process was told to use: an older launcher finds the state through the old name
  linkLegacyRegistry(legacy, next);
  if (env["OVIS_STATE_DIR"]) return;
  if (supervisor && defaultStateDir(env, supervisor) !== defaultStateDir(env)) return;
  moved = true;
  adoptLegacyDir(legacy, next);
}

/**
 * Moves `legacy` to `next` and leaves a link at the old name for a launcher, plugin or older
 * release that still uses it. A link at `legacy` moves as a link, so state kept elsewhere stays
 * there. Where the move fails, or `next` already holds other files, the old dir stays in use;
 * an old dir that holds only the bridge registry then joins the new one (linkLegacyRegistry).
 */
export function adoptLegacyDir(legacy: string, next: string): void {
  const contents = legacyContents(legacy, next);
  if (contents === null) return;
  // the registry alone beside a new dir with files: the registry joins it
  if (contents === "registry" && isDir(next) && readdirSync(next).length > 0) return linkLegacyRegistry(legacy, next);
  try {
    // an empty dir at the new name gives way; one with files of its own stays
    if (isDir(next)) rmdirSync(next);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: another process of this install removed it first, and the move goes on
    if (code !== "ENOENT") {
      if (holdsOwnState(legacy, next)) console.error(code === "ENOTEMPTY" || code === "EEXIST"
        ? `both ${legacy} and ${next} hold files, so the state in ${legacy} stays in use; move what you keep into one of them`
        : `cannot move ${legacy} to ${next}, so the old state dir stays in use: ${(error as Error).message}`);
      return;
    }
  }
  try {
    renameSync(legacy, next);
  } catch (error) {
    // another process of this install moved it first
    if (legacyContents(legacy, next) === null) return;
    console.error(`cannot move ${legacy} to ${next}, so the old state dir stays in use: ${(error as Error).message}`);
    return;
  }
  try {
    // "junction" needs no privilege on Windows; other platforms ignore the type
    symlinkSync(next, legacy, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    console.error(`moved ${legacy} to ${next} but cannot link the old name to it: ${(error as Error).message}`);
  }
}

/** One update state per source checkout and port, so two checkouts or ports never share builds. */
export function updateStateDir(root: string, port: number, stateDir = defaultStateDir()): string {
  return join(resolve(stateDir), "updates",
    createHash("sha256").update(`${resolve(root)}:${port}`).digest("hex").slice(0, 16));
}

/** A supervisor exits with this after an install: "start the supervisor of the release now active"
 * (EX_TEMPFAIL, never a crash code). */
export const HANDOVER_EXIT = 75;
