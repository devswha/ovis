/**
 * The hosted shell the Android app carries (docs/native-app.md, "The bundled shell"): a dist-shell copied into the
 * app's assets, which the app serves at the hosted shell's own origin with no network (BundledShell.java), so a person
 * who updates from a build that loaded it from the network keeps that origin's storage: sign-in, keys and pairings.
 *
 * OVIS_APP_SHELL picks where the shell comes from: `bundled` (the app's assets) or `hosted` (the network, at
 * OVIS_APP_URL's origin, as every build did before: the owner's preview app and the QA twin). OVIS_APP_SHELL_DIR names
 * the dist-shell to carry (a release passes its tag's verified dist-shell.tar.gz, unpacked); without it the shell is
 * built from this checkout, as the demo is. android/app/build.gradle reads the choice from hosted-origin.properties
 * (hosted-origin.ts) and refuses to package a hosted shell as the store app.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { RENDER_PATH, SHELL_META } from "../../scripts/shell-build.ts";

export type AppShell = "bundled" | "hosted";

/**
 * OVIS_APP_SHELL: `bundled` or `hosted`. Unset, a build of the production origin (no OVIS_APP_URL, what a store build
 * is) carries the shell, and a build for another origin (`appUrl`, a preview shell, which exists to be loaded) loads
 * it from the network, as such builds always did.
 */
export function appShell(value: string | undefined, appUrl: string | null): AppShell {
  if (!value) return appUrl === null ? "bundled" : "hosted";
  if (value !== "bundled" && value !== "hosted") throw new Error(`OVIS_APP_SHELL must be bundled or hosted: ${value}`);
  return value;
}

/**
 * Where, under app/, the carried shell is written once for every platform's build: `shell/` is the dist-shell the app
 * serves, `shell-policy.json` the policies it sends with it (`page` on every answer, `render` alone on a PC's render
 * host). Outside app/www, so `bunx cap sync` leaves it alone and the app's own origin (https://localhost) never serves
 * it: the Android build adds it as an assets folder of its own (android/app/build.gradle), and the iOS build copies it
 * into the app as it is (ios/carry-shell.sh).
 */
export const SHELL_ASSETS = "bundled-shell";

/** The carried copy's size limit: 31 MB on 2026-11-24, so a copy that doubles (sidecars, a second copy) fails the build. */
export const SHELL_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Whether the dist-shell file at `path` (relative, `/`-separated) goes into the app: not the server's precompressed
 * copies (the app reads files itself, and Android's asset merger takes `x.js` and `x.js.gz` for one asset), and not
 * Pages' own files, whose rules the app carries out itself (`_headers`, `_redirects`) or which only the web host
 * answers (`.well-known/`, the app links' files).
 */
export function carried(path: string): boolean {
  if (/\.(gz|br)$/.test(path)) return false;
  if (path === "_headers" || path === "_redirects") return false;
  return !(path === ".well-known" || path.startsWith(".well-known/"));
}

/**
 * The two policies a dist-shell's `_headers` gives (scripts/shell-build.ts shellHeaders): `page` on every path,
 * `render` alone on a PC's render host, the first detached there. Read from the copy carried, so the app sends what
 * Pages sends for that very copy; anything else in that place throws.
 */
export function shellPoliciesOf(headers: string): { page: string; render: string } {
  const blocks = new Map<string, string[]>();
  let path: string | null = null;
  for (const line of headers.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) { path = null; continue; }
    if (!/^\s/.test(line)) { path = line.trim(); blocks.set(path, []); continue; }
    if (path !== null) blocks.get(path)!.push(line.trim());
  }
  const policy = (lines: string[] | undefined) => lines?.filter((line) => line.startsWith("Content-Security-Policy:")).map((line) => line.slice("Content-Security-Policy:".length).trim()) ?? [];
  const page = policy(blocks.get("/*"));
  const render = policy(blocks.get(RENDER_PATH));
  if (page.length !== 1 || !page[0]) throw new Error("the dist-shell's _headers gives no one Content-Security-Policy for /*");
  if (render.length !== 1 || !render[0] || !blocks.get(RENDER_PATH)?.includes("! Content-Security-Policy")) {
    throw new Error(`the dist-shell's _headers gives ${RENDER_PATH} no policy of its own`);
  }
  return { page: page[0], render: render[0] };
}

/** Every file under `dir`, relative and `/`-separated. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => statSync(join(dir, file)).isFile())
    .map((file) => file.split(sep).join("/"));
}

/**
 * Copies the dist-shell `from` into `assets` (SHELL_ASSETS): its files the app carries into `shell/` and the policies of
 * its `_headers` into `shell-policy.json`. Throws, copying nothing, when `from` is not a dist-shell or the copy would be
 * over `budget` bytes.
 */
export function packShell(from: string, assets: string, budget = SHELL_BUDGET_BYTES): { files: number; bytes: number } {
  for (const file of ["index.html", "render.html", "manifest.webmanifest", "_headers"]) {
    if (!existsSync(join(from, file))) throw new Error(`${from} is not a dist-shell: it holds no ${file} (bun run build:shell makes one)`);
  }
  if (!readFileSync(join(from, "index.html"), "utf8").includes(SHELL_META)) throw new Error(`${from}/index.html is not the shell's: it lacks ${SHELL_META}`);
  const policies = shellPoliciesOf(readFileSync(join(from, "_headers"), "utf8"));
  const files = filesIn(from).filter(carried);
  const bytes = files.reduce((sum, file) => sum + statSync(join(from, file)).size, 0);
  if (bytes > budget) {
    const top = new Map<string, number>();
    for (const file of files) top.set(file.split("/")[0]!, (top.get(file.split("/")[0]!) ?? 0) + statSync(join(from, file)).size);
    const largest = [...top].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, size]) => `${name} ${(size / 1048576).toFixed(1)} MB`).join(", ");
    throw new Error(`the shell to carry is ${(bytes / 1048576).toFixed(1)} MB, over its ${(budget / 1048576).toFixed(0)} MB budget (SHELL_BUDGET_BYTES; it was 31 MB on 2026-11-24). Largest: ${largest}. Find what grew before raising it.`);
  }
  const into = join(assets, "shell");
  mkdirSync(into, { recursive: true });
  for (const file of files) cpSync(join(from, file), join(into, file));
  writeFileSync(join(assets, "shell-policy.json"), `${JSON.stringify(policies)}\n`);
  return { files: files.length, bytes };
}

/** The shell built from this checkout into `out`, as `bun run build:shell` builds it, for a build given no OVIS_APP_SHELL_DIR. */
export function buildShell(out: string): void {
  const repo = join(import.meta.dir, "../..");
  const vite = Bun.spawnSync([process.execPath, "--bun", join(repo, "node_modules/.bin/vite"), "build", "--mode", "shell", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo, env: process.env, stderr: "pipe", stdout: "ignore" });
  if (vite.exitCode !== 0) throw new Error(`the shell did not build:\n${new TextDecoder().decode(vite.stderr)}`);
}

