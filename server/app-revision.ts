import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVISION } from "../shared/update.ts";

/**
 * The commit this app's own build was made from, in every runtime: OVIS_REVISION where a supervisor runs a release of it,
 * else the build.json vite wrote into dist/ beside the server (the desktop app's server, which no supervisor runs, and a
 * built checkout's). Undefined for a build that names none (a dev server, or a build outside git).
 */
export function buildRevision(root = join(import.meta.dir, ".."), env: Record<string, string | undefined> = process.env): string | undefined {
  const named = env["OVIS_REVISION"];
  if (named && REVISION.test(named)) return named;
  try {
    const revision = (JSON.parse(readFileSync(join(root, "dist", "build.json"), "utf8")) as { revision?: unknown }).revision;
    return typeof revision === "string" && REVISION.test(revision) ? revision : undefined;
  } catch { return undefined; }
}

/** This app's build, replaceable in tests. */
export const appBuild = { revision: (): string | undefined => buildRevision() };
