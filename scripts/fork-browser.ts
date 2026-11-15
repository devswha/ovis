/** Fork browser lane: always run fork regressions, plus this PR/push's changed browser scripts.
 * ci-browser-parallel.ts requires serial registration. Extend that list only during this isolated
 * CI invocation (including upstream QA scripts not in the serial lane), then restore it verbatim. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serialBrowserScripts } from "./ci-browser-parallel.ts";

const browserScript = /^scripts\/[\w.-]+(?:-regression|-qa)\.ts$/;
export function selectForkBrowserScripts(fork: string[], changed: string[]): string[] {
  return [...new Set([...fork, ...changed].filter((path) => browserScript.test(path)))].sort();
}

export function excludeUpstreamBrowserCopies(cwd: string, selected: string[], upstream: string): string[] {
  const available = /^[a-f0-9]{40}$/.test(upstream) && Bun.spawnSync(["git", "cat-file", "-e", `${upstream}^{commit}`], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (!available) {
    console.warn("fork browser: upstream baseline unavailable; running all changed browser scripts");
    return selected;
  }
  return selected.filter((script) => {
    if (/^scripts\/fork-.*-regression\.ts$/.test(script)) return true;
    const blob = Bun.spawnSync(["git", "cat-file", "blob", `${upstream}:${script}`], { cwd, stdout: "pipe", stderr: "pipe" });
    return blob.exitCode !== 0 || !blob.stdout.equals(readFileSync(join(cwd, script)));
  });
}

export function changedBrowserScripts(cwd: string, base: string, event: string): string[] {
  if (event !== "pull_request" && event !== "push") return [];
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("FORK_BROWSER_BASE must be a full commit SHA");
  let range: string[];
  if (/^0+$/.test(base)) {
    if (event !== "push") throw new Error("A pull request needs a nonzero base SHA");
    const empty = Bun.spawnSync(["git", "hash-object", "-t", "tree", "--stdin"], { cwd, stdin: new Uint8Array(), stdout: "pipe", stderr: "pipe" });
    if (empty.exitCode !== 0) throw new Error(empty.stderr.toString());
    range = [empty.stdout.toString().trim(), "HEAD"];
  } else range = event === "pull_request" ? [`${base}...HEAD`] : [base, "HEAD"];
  const diff = Bun.spawnSync(["git", "diff", "--name-only", "--diff-filter=ACMR", "-z", ...range, "--", "scripts"], { cwd, stdout: "pipe", stderr: "pipe" });
  if (diff.exitCode !== 0) throw new Error(diff.stderr.toString());
  return diff.stdout.toString().split("\0").filter((path) => browserScript.test(path)).sort();
}

async function main(): Promise<number> {
  const cwd = process.cwd();
  const fork = [...new Bun.Glob("scripts/fork-*-regression.ts").scanSync({ cwd })];
  const changed = changedBrowserScripts(cwd, process.env["FORK_BROWSER_BASE"] ?? "", process.env["FORK_BROWSER_EVENT"] ?? "workflow_dispatch");
  const selected = excludeUpstreamBrowserCopies(cwd, selectForkBrowserScripts(fork, changed), process.env["FORK_BROWSER_UPSTREAM"] ?? "");
  if (!selected.length) throw new Error("No fork browser regressions found");
  if (process.argv[2] === "--list") { console.log(JSON.stringify(selected)); return 0; }
  const path = join(cwd, "scripts/ci-browser.sh");
  const original = readFileSync(path, "utf8");
  const registered = serialBrowserScripts(original);
  const missing = selected.filter((script) => !registered.includes(script));
  if (missing.length) writeFileSync(path, `${original}\n${missing.map((script) => `run_script ${script}`).join("\n")}\n`);
  try {
    console.log(`fork browser: ${selected.length} scripts`);
    const child = Bun.spawn([process.execPath, "scripts/ci-browser-parallel.ts"], {
      cwd, env: { ...process.env, BROWSER_SCRIPTS: selected.join(","), BROWSER_RETRY: "0", BROWSER_SHARD: "", BROWSER_EXCLUDE: "" },
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
    return await child.exited;
  } finally { if (missing.length) writeFileSync(path, original); }
}
if (import.meta.main) process.exit(await main());
