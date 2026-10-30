import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { MIN_SERVER_VERSION } from "../shared/relay-mux.ts";

const SKEW = join(import.meta.dir, "relay-skew.ts");
const SKEW_TEST_MS = 60_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch checkout whose only release, the minimum's tag, holds server/relay/ and a
 * server/devices.ts that reads any registry. `build` is its build scripts' command.
 */
async function releaseWithRelay(build: string): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "ovis-relay-skew-test-"));
  dirs.push(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "skew-fixture", private: true, scripts: { build, "build:shell": build } }));
  mkdirSync(join(repo, "server/relay"), { recursive: true });
  writeFileSync(join(repo, "server/relay/README.md"), "relay\n");
  writeFileSync(join(repo, "server/devices.ts"), 'export function readDeviceRegistry() { return { kind: "ok", devices: [{ relay_public_key: "fixture" }] }; }\n');
  await $`bun install`.cwd(repo).quiet();
  await $`git init -q && git add -A && git -c user.name=skew -c user.email=skew@example.invalid commit -q -m fixture && git tag ${`v${MIN_SERVER_VERSION}`}`.cwd(repo).quiet();
  return repo;
}

async function skew(repo: string): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["bun", "-e", `const { main } = await import(${JSON.stringify(SKEW)}); await main(${JSON.stringify(repo)});`], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: stdout + stderr };
}

describe("relay-skew", () => {
  it("skips a release that holds server/relay/ with a notice while the e2e run does not exist", async () => {
    // Given a release with the relay, a checkout without scripts/relay-e2e-regression.ts, and builds that fail if run
    const repo = await releaseWithRelay("exit 9");
    // When
    const { code, output } = await skew(repo);
    // Then nothing was built or driven, and the job passes with a notice naming the missing run
    expect(code).toBe(0);
    expect(output).toMatch(/^::notice .*scripts\/relay-e2e-regression\.ts/m);
  }, SKEW_TEST_MS);

  it("fails when the e2e run exists and fails", async () => {
    // Given a release with the relay and an e2e run that reports the server tree it got, then fails
    const repo = await releaseWithRelay("true");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts/relay-e2e-regression.ts"), 'console.log(`E2E RAN ${process.env["RELAY_E2E_SERVER_DIR"]}`);\nprocess.exit(3);\n');
    // When
    const { code, output } = await skew(repo);
    // Then the run was reached against the tag's tree, and its failure fails the job
    expect(output).toMatch(new RegExp(`E2E RAN \\S+/v${MIN_SERVER_VERSION.replaceAll(".", "\\.")}`));
    expect(output).not.toContain("skipped");
    expect(code).not.toBe(0);
  }, SKEW_TEST_MS);
});
