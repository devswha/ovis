import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import type { FileInfo } from "../shared/protocol.ts";
import { findFile, resolveFilePath } from "./file-view.ts";

/**
 * Where a project keeps its icon, best first. A site's favicon leads; then the icons frameworks
 * and app builders keep (Next.js app/, Electron's build/ and resources/, Expo and Flutter
 * assets/), then a square logo, which may be a wordmark.
 */
export const FAVICON_CANDIDATES = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
  "app/icon.svg", "app/icon.png", "app/favicon.ico",
  "src/app/icon.svg", "src/app/icon.png", "src/app/favicon.ico",
  "public/icon.svg", "public/icon.png", "public/apple-touch-icon.png",
  "icon.svg", "icon.png", "build/icon.png", "resources/icon.png", "assets/icon.png",
  "logo.svg", "logo.png", "assets/logo.svg", "assets/logo.png", "public/logo.svg", "public/logo.png",
  "src/assets/logo.svg", "src/assets/logo.png", ".github/logo.svg", ".github/logo.png",
] as const;

// a workspace glob that ends in ** could name every folder of a big repo
const MAX_WORKSPACES = 200;

/**
 * The best candidate in `root` that is an image, or null. Each place is read as GET /api/fs/stat
 * reads `<root>/<place>` with no pane: `root` is absolute or `~/…`, and a relative one, with no
 * pane folder to be relative to, keeps no icon. A monorepo keeps its icons in its workspaces, so
 * when the root holds none, each workspace it declares is asked in turn.
 */
export async function findProjectFavicon(root: string): Promise<FileInfo | null> {
  const own = await faviconIn(root);
  if (own !== null) return own;
  const folder = resolveFilePath(root, null);
  if (folder === null) return null;
  for (const workspace of await workspaceFolders(folder)) {
    const found = await faviconIn(workspace);
    if (found !== null) return found;
  }
  return null;
}

async function faviconIn(folder: string): Promise<FileInfo | null> {
  for (const candidate of FAVICON_CANDIDATES) {
    const found = await findFile(join(folder, candidate), null, () => Promise.resolve(null));
    if (found !== null && "info" in found && found.info.kind === "image") return found.info;
  }
  return null;
}

/**
 * The workspace folders `root` declares, in the order it declares them: package.json's
 * "workspaces" (a list, or one under "packages"), then pnpm-workspace.yaml's "packages". A file
 * that is missing or does not parse declares none, and a folder outside `root`, through `..` or a
 * link, is never one.
 */
async function workspaceFolders(root: string): Promise<string[]> {
  const patterns = [
    ...await declared(join(root, "package.json"), JSON.parse, (manifest) => field(field(manifest, "workspaces"), "packages") ?? field(manifest, "workspaces")),
    ...await declared(join(root, "pnpm-workspace.yaml"), Bun.YAML.parse, (manifest) => field(manifest, "packages")),
  ].map((pattern) => pattern.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, ""));
  const top = await realpath(root).catch(() => null);
  if (top === null) return [];
  const excluded = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => new Bun.Glob(pattern.slice(1).replace(/^(?:\.\/)+/, "")));
  const folders: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (pattern === "" || pattern.startsWith("!") || pattern.startsWith("/") || pattern.split("/").includes("..")) continue;
    let matches: string[];
    try { matches = (await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: top, onlyFiles: false }))).sort(); } catch { continue; }
    for (const match of matches) {
      if (match.split(sep).includes("node_modules") || excluded.some((glob) => glob.match(match))) continue;
      const real = await realpath(join(top, match)).catch(() => null);
      if (real === null || seen.has(real) || !real.startsWith(top + sep) || !(await stat(real).catch(() => null))?.isDirectory()) continue;
      seen.add(real);
      folders.push(join(root, match));
      if (folders.length === MAX_WORKSPACES) return folders;
    }
  }
  return folders;
}

/** The strings `pick` finds in the file at `path`, or none when it is missing or does not parse. */
async function declared(path: string, parse: (text: string) => unknown, pick: (parsed: unknown) => unknown): Promise<string[]> {
  try {
    const list = pick(parse(await readFile(path, "utf8")));
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}
