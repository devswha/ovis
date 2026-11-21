import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  it.each([
    ["the client", ["src/App.tsx"]],
    ["the server", ["server/index.ts"]],
    ["the wire contract", ["shared/protocol.ts"]],
    ["a browser script", ["scripts/sidebar-filter-demo-regression.ts"]],
    ["a helper of tests, which a browser script may load", ["server/relay/test-helpers.ts"]],
    ["the demo", ["site/demo/transport.ts"]],
    ["the relay", ["relay/src/worker.ts"]],
    ["the desktop app", ["app/electron/src/browserTabs.ts"]],
    ["the PTY host", ["crates/pty-sidecar/src/main.rs"]],
    ["a dependency", ["bun.lock"]],
    ["ci.yml itself", [".github/workflows/ci.yml"]],
    ["the action its jobs set up with", [".github/actions/setup-ci/action.yml"]],
    ["this script", ["scripts/ci-browser-reach.sh"]],
    ["a server fixture, text or not", ["server/fixtures/prompt.txt"]],
    ["the release summaries the server reads for its update notes", ["release-summaries.json"]],
    ["a folder the list does not name", ["plugins/new/index.ts"]],
    ["one reaching path among others that do not", ["tui/src/main.zig", "README.md", "src/lib/api.ts"]],
    ["no path at all", []],
  ])("keeps them for %s", (_, paths) => {
    expect(reach(...paths)).toBe("browser=true\n");
  });

  it.each([
    ["documentation", ["docs/guide.md", "README.md"]],
    ["unit tests", ["server/relay/service.test.ts", "src/components/Sidebar.test.tsx", "scripts/ci-runner-route.test.ts"]],
    ["the terminal client", ["tui/src/main.zig", "crates/ovis-tui/src/main.rs"]],
    ["the workers no browser job starts", ["push-relay/src/index.ts", "telemetry/src/worker.ts"]],
    ["the phone and native apps' own folders", ["app/android/app/build.gradle", "app/ios/App/Info.plist", "app/windows/Program.cs", "app/mac/Ovis.swift", "app/store/listing.json"]],
    ["the installers", ["install.sh", "install.ps1"]],
    ["the runner launcher", ["scripts/self-hosted-runner/run.sh"]],
    ["another workflow", [".github/workflows/beta.yml", ".github/workflows/remote-bundles.yml"]],
    ["a changelog fragment beside a unit test", ["changelog.d/fix.md", "server/store.test.ts"]],
  ])("leaves them out for %s", (_, paths) => {
    expect(reach(...paths)).toBe("browser=false\n");
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
