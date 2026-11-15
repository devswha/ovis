/**
 * `bun scripts/build-relay.ts <platform> <dir>`: the relay for someone who runs their own (relay/README.md, "Running your own"):
 *
 * - `<dir>/ovis-relay` (`ovis-relay.exe` on Windows): relay/bun.ts compiled, with the same flags (`--port`,
 *   `--max-clients-per-server`, `--max-sockets-per-address` and the rest).
 * - `<dir>/ovis-relay-worker.js` and `<dir>/wrangler.toml`: the Cloudflare Worker as one module, with the settings
 *   relay/wrangler.toml gives relay.ovis.sh made fit for an account of one's own: a workers.dev address instead of
 *   relay.ovis.sh, no staging copy, and passes off (a relay someone runs stays open).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const RELAY_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64"] as const;
export const WORKER_BUNDLE = "ovis-relay-worker.js";

const root = join(import.meta.dir, "..");

/** relay/wrangler.toml as `<dir>/wrangler.toml` deploys the prebuilt bundle on another account. */
export function selfHostedWranglerToml(production: string): string {
  const lines = production.split("\n");
  // the staging copy and everything after it are Ovis's own, as are the production [vars] (its pass settings)
  let end = lines.findIndex((line) => line.startsWith("[env."));
  while (end > 0 && (lines[end - 1]!.startsWith("#") || lines[end - 1]!.trim() === "")) end--;
  const out: string[] = [];
  let skipping = false;
  for (const line of lines.slice(0, end === -1 ? lines.length : end)) {
    if (/^\[.*\]$/.test(line.trim())) skipping = line.trim() === "[vars]";
    if (skipping) continue;
    if (line.startsWith("main = ")) out.push(`main = "${WORKER_BUNDLE}"`);
    else if (line.startsWith("workers_dev = ")) out.push("workers_dev = true");
    else if (!line.startsWith("routes = ") && !line.includes("relay.ovis.sh")) out.push(line);
  }
  while (out.length > 0 && (out.at(-1)!.startsWith("#") || out.at(-1)!.trim() === "")) out.pop();
  return `# The Ovis relay as a Cloudflare Worker on your own account (relay/README.md, "Running your own"):\n# \`wrangler deploy\` from this folder. namespace_id values must be unique on your account.\n${out.join("\n")}\n`;
}

/** Builds the relay binary for `platform` and the Worker bundle into `dir`; returns the exit code. */
export async function buildRelay(platform: string | undefined, dir: string | undefined): Promise<number> {
  if (platform === undefined || !(RELAY_PLATFORMS as readonly string[]).includes(platform) || dir === undefined) {
    console.error(`usage: bun scripts/build-relay.ts <${RELAY_PLATFORMS.join("|")}> <dir>`);
    return 2;
  }
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  const run = async (args: string[]) => Bun.spawn([process.execPath, "build", ...args], { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited;
  // `--format=esm` because relay/bun.ts awaits at top level, which bytecode allows only in an ES module
  const binary = await run(["--compile", "--minify", "--bytecode", "--format=esm", `--target=bun-${platform}`, "relay/bun.ts", "--outfile", join(out, "ovis-relay")]);
  if (binary !== 0) return binary;
  const bundle = await run(["--target=browser", "--format=esm", "relay/worker.ts", "--outfile", join(out, WORKER_BUNDLE)]);
  if (bundle !== 0) return bundle;
  writeFileSync(join(out, "wrangler.toml"), selfHostedWranglerToml(readFileSync(join(root, "relay", "wrangler.toml"), "utf8")));
  return 0;
}

if (import.meta.main) process.exit(await buildRelay(process.argv[2], process.argv[3]));
