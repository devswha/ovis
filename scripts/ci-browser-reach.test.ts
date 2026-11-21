import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, runScript } from "./shell-workflow-rules.ts";

type Job = { if?: string; needs?: string | string[]; steps?: { name?: string; run?: string }[] };
const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };
const BROWSER = "needs.changes.outputs.code == 'true' && needs.changes.outputs.browser != 'false'";

function reach(...paths: string[]): string {
  const result = spawnSync("bash", [join(root, "scripts/ci-browser-reach.sh")], { input: paths.map((path) => `${path}\n`).join(""), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("a pull request's reach into the browser jobs", () => {
  const KEPT: [string, string[][]][] = [
    ["the client", [["src/App.tsx"]]],
    ["the server", [["server/index.ts"]]],
    ["the wire contract", [["shared/protocol.ts"]]],
    ["a browser script", [["scripts/sidebar-filter-demo-regression.ts"]]],
    ["a helper of tests, which a browser script may load", [["server/relay/test-helpers.ts"]]],
    ["the demo", [["site/demo/transport.ts"]]],
    ["the relay", [["relay/src/worker.ts"]]],
    ["the desktop app", [["app/electron/src/browserTabs.ts"]]],
    ["the PTY host", [["crates/pty-sidecar/src/main.rs"]]],
    ["a dependency", [["bun.lock"]]],
    ["ci.yml itself", [[".github/workflows/ci.yml"]]],
    ["the action its jobs set up with", [[".github/actions/setup-ci/action.yml"]]],
    ["this script", [["scripts/ci-browser-reach.sh"]]],
    ["a server fixture, a test file among them", [["server/fixtures/prompt.txt"], ["server/fixtures/case.test.ts"]]],
    ["the release summaries the server reads for its update notes", [["release-summaries.json"]]],
    ["a docs page a browser script reads its example from, beside a unit test", [["docs/themes.md", "server/access.test.ts"]]],
    ["the notices the client build bundles", [["THIRD_PARTY_NOTICES.md", "server/access.test.ts"]]],
    ["the worker folder a browser script copies", [["telemetry/src/worker.ts"]]],
    ["the attributes that decide how every script is checked out", [[".gitattributes"]]],
    ["a folder the list does not name", [["plugins/new/index.ts"]]],
    ["a folder's own name, which is no path inside it", [["tui"]]],
    ["a name git quotes", [["\"docs/\\303\\251.md\""]]],
    ["one reaching path among others that do not", [["tui/src/main.zig", "changelog.d/fix.md", "src/lib/api.ts"]]],
    ["no path at all", [[]]],
  ];
  it.each(KEPT)("keeps them for %s", (_, lists) => {
    for (const paths of lists) expect(reach(...paths)).toBe("browser=true\n");
  });

  it.each([
    ["unit tests", ["server/relay/service.test.ts", "src/components/Sidebar.test.tsx", "scripts/ci-runner-route.test.ts", "integrations/gjc.test.ts"]],
    ["the terminal client", ["tui/src/main.zig", "crates/ovis-tui/src/main.rs"]],
    ["the push worker and the site", ["push-relay/src/index.ts", "ovis-site/index.html"]],
    ["the phone and native apps' own folders", ["app/android/app/build.gradle", "app/ios/App/Info.plist", "app/windows/Program.cs", "app/mac/Ovis.swift", "app/store/listing.json"]],
    ["the installers", ["install.sh", "install.ps1"]],
    ["the runner launcher", ["scripts/self-hosted-runner/run.sh"]],
    ["another workflow", [".github/workflows/beta.yml", ".github/workflows/remote-bundles.yml"]],
    ["a changelog fragment beside a unit test", ["changelog.d/fix.md", "server/store.test.ts"]],
  ])("leaves them out for %s", (_, paths) => {
    expect(reach(...paths)).toBe("browser=false\n");
  });

  it("reads a last line that has no newline", () => {
    const result = spawnSync("bash", [join(root, "scripts/ci-browser-reach.sh")], { input: "tui/src/main.zig\nsrc/App.tsx", encoding: "utf8" });
    expect(result.stdout).toBe("browser=true\n");
  });

  const NAMED_NOT_READ: Record<string, string> = {
    "scripts/conventions.test.ts": "scripts/demo-server.ts names it in a comment",
  };

  it("leaves out no path that a browser job's script names", () => {
    const lane = [...readFileSync(join(root, "scripts/ci-browser.sh"), "utf8").matchAll(/scripts\/[A-Za-z0-9_-]+\.ts/g)].map((match) => match[0]);
    const sources = [...new Set([...lane, "vite.config.ts", "scripts/build-cache.ts", "scripts/ci-browser-parallel.ts", "scripts/ci-browser.sh", "scripts/demo-server.ts", "scripts/test-herdr.ts", "scripts/test-shell.ts", "scripts/ci-chromium.sh", "scripts/ci-ffmpeg.sh", "scripts/check.ts"])].filter((file) => existsSync(join(root, file)));
    expect(lane.length).toBeGreaterThan(100);
    const named = new Map<string, string>();
    for (const file of sources) {
      for (const match of readFileSync(join(root, file), "utf8").matchAll(/["'`]([A-Za-z0-9_.@/-]{2,120})["'`]/g)) {
        const name = match[1]!.replace(/^(\.\.?\/)+/, "").replace(/^\//, "").replace(/\/$/, "");
        if (name === "" || name === "." || name === ".." || !existsSync(join(root, name))) continue;
        named.set(statSync(join(root, name)).isDirectory() ? `${name}/x` : name, file);
      }
    }
    const paths = [...named.keys()];
    const result = spawnSync("bash", ["-c", "while IFS= read -r path; do printf '%s\\n' \"$path\" | bash \"$0\" | grep -q browser=false && echo \"$path\"; done; true", join(root, "scripts/ci-browser-reach.sh")], { input: paths.map((path) => `${path}\n`).join(""), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const leftOut = result.stdout.split("\n").filter((path) => path !== "");
    expect(leftOut.filter((path) => !(path in NAMED_NOT_READ)).map((path) => `${path} (named in ${named.get(path)})`), "A browser job's script names a path that scripts/ci-browser-reach.sh leaves out, so a pull request changing only that path would skip the job that reads it. Take the path out of the script's list, or, when the script only names it and never reads it, list it in NAMED_NOT_READ here with where.").toEqual([]);
    expect(Object.keys(NAMED_NOT_READ).filter((path) => !leftOut.includes(path)), "These are no longer named by a browser job's script or no longer left out: remove them from NAMED_NOT_READ.").toEqual([]);
  });
});

describe("ci.yml and the browser jobs a change cannot reach", () => {
  it("skips only the two browser jobs, and only by the change's reach", () => {
    expect(ci.jobs["browser-main"]!.if).toBe(BROWSER);
    expect(ci.jobs["browser-other"]!.if).toBe(BROWSER);
    expect(Object.entries(ci.jobs).filter(([, job]) => (job.if ?? "").includes("outputs.browser")).map(([id]) => id)).toEqual(["browser-main", "browser-other"]);
    expect(ci.jobs["integration-browser"]!.needs).toEqual(["changes", "integration", "browser-main", "browser-other"]);
  });

  const verdict = async (env: Record<string, string>): Promise<number> => {
    const check = ci.jobs["integration-browser"]!.steps!.find((step) => step.name === "Check results")!;
    return (await runScript(check.run!, tmpdir(), { CODE: "true", DRAFT: "false", BROWSER: "true", INTEGRATION_RESULT: "success", BROWSER_MAIN_RESULT: "success", BROWSER_OTHER_RESULT: "success", ...env })).code;
  };
  const SKIPPED = { BROWSER_MAIN_RESULT: "skipped", BROWSER_OTHER_RESULT: "skipped" };

  it("passes the required check on skipped browser jobs only when the change cannot reach them", async () => {
    expect(await verdict({})).toBe(0);
    expect(await verdict({ BROWSER: "false", ...SKIPPED })).toBe(0);
    expect(await verdict({ BROWSER: "true", ...SKIPPED })).toBe(1);
    expect(await verdict({ BROWSER: "", ...SKIPPED })).toBe(1);
    expect(await verdict({ BROWSER: "False", ...SKIPPED })).toBe(1);
  });

  it("fails it when a browser job that was to be skipped ended any other way, or the integration tests did not pass", async () => {
    expect(await verdict({ BROWSER: "false", BROWSER_MAIN_RESULT: "failure", BROWSER_OTHER_RESULT: "skipped" })).toBe(1);
    expect(await verdict({ BROWSER: "false", BROWSER_MAIN_RESULT: "skipped", BROWSER_OTHER_RESULT: "cancelled" })).toBe(1);
    expect(await verdict({ BROWSER: "false", BROWSER_MAIN_RESULT: "success", BROWSER_OTHER_RESULT: "skipped" })).toBe(1);
    expect(await verdict({ BROWSER: "false", ...SKIPPED, INTEGRATION_RESULT: "failure" })).toBe(1);
    expect(await verdict({ BROWSER: "false", ...SKIPPED, INTEGRATION_RESULT: "skipped" })).toBe(1);
    expect(await verdict({ BROWSER: "false", ...SKIPPED, DRAFT: "true" })).toBe(1);
  });
});
