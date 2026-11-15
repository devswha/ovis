import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedBrowserScripts, excludeUpstreamBrowserCopies, selectForkBrowserScripts } from "./fork-browser.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "fork-browser-")); roots.push(dir);
  mkdirSync(join(dir, "scripts"));
  return dir;
}
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

it("includes every fork regression plus changed regression/QA scripts, once", () => {
  expect(selectForkBrowserScripts(["scripts/fork-b-regression.ts", "scripts/fork-a-regression.ts"], ["scripts/fork-a-regression.ts", "scripts/a-qa.ts", "scripts/a-regression.ts", "scripts/not-browser.ts"]))
    .toEqual(["scripts/a-qa.ts", "scripts/a-regression.ts", "scripts/fork-a-regression.ts", "scripts/fork-b-regression.ts"]);
});

it("diffs PRs from their merge base and pushes from the exact previous commit, excluding deletions", () => {
  const dir = root();
  git(dir, "init", "-q", "-b", "base");
  git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@localhost");
  writeFileSync(join(dir, "scripts/deleted-qa.ts"), "old");
  writeFileSync(join(dir, "scripts/existing-qa.ts"), "old");
  git(dir, "add", "."); git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-qb", "topic");
  writeFileSync(join(dir, "scripts/topic-regression.ts"), "topic");
  rmSync(join(dir, "scripts/deleted-qa.ts"));
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "topic");
  git(dir, "checkout", "-q", "base");
  writeFileSync(join(dir, "scripts/base-regression.ts"), "base change");
  writeFileSync(join(dir, "scripts/existing-qa.ts"), "new");
  git(dir, "add", "."); git(dir, "commit", "-qm", "base moved");
  const moved = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "topic");
  expect(changedBrowserScripts(dir, moved, "pull_request")).toEqual(["scripts/topic-regression.ts"]);
  expect(changedBrowserScripts(dir, moved, "push")).toEqual(["scripts/existing-qa.ts", "scripts/topic-regression.ts"]);
  expect(changedBrowserScripts(dir, base, "push")).toEqual(["scripts/topic-regression.ts"]);
  expect(changedBrowserScripts(dir, "0".repeat(40), "push")).toEqual(["scripts/existing-qa.ts", "scripts/topic-regression.ts"]);
  expect(changedBrowserScripts(dir, "", "workflow_dispatch")).toEqual([]);
  expect(() => changedBrowserScripts(dir, "--output=bad", "push")).toThrow("SHA");
});

it("skips byte-identical upstream copies, but keeps fork-owned, modified and missing scripts", () => {
  const dir = root();
  git(dir, "init", "-q", "-b", "base");
  git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@localhost");
  const same = "scripts/same-qa.ts", changed = "scripts/changed-regression.ts", own = "scripts/fork-own-regression.ts", missing = "scripts/missing-qa.ts";
  for (const file of [same, changed, own]) writeFileSync(join(dir, file), "upstream\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "upstream");
  const upstream = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, changed), "fork\r\n");
  writeFileSync(join(dir, missing), "fork");
  const selected = [changed, own, missing, same];
  expect(excludeUpstreamBrowserCopies(dir, selected, upstream)).toEqual([changed, own, missing]);
  expect(excludeUpstreamBrowserCopies(dir, selected, "")).toEqual(selected);
  git(dir, "add", "."); git(dir, "commit", "-qm", "fork");
  for (const baseline of [upstream, ""]) {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "fork-browser.ts"), "--list"], {
      cwd: dir, env: { ...process.env, FORK_BROWSER_EVENT: "push", FORK_BROWSER_BASE: "0".repeat(40), FORK_BROWSER_UPSTREAM: baseline }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual((baseline ? [changed, own, missing] : selected).sort());
  }
});

it.each([0, 2])("registers missing scripts only for the disposable run and preserves exit %s", (code) => {
  const dir = root();
  const source = "#!/usr/bin/env bash\nrun_script scripts/base-regression.ts\n";
  writeFileSync(join(dir, "scripts/ci-browser.sh"), source);
  writeFileSync(join(dir, "scripts/fork-fixture-regression.ts"), "");
  writeFileSync(join(dir, "scripts/ci-browser-parallel.ts"), `import {readFileSync} from "node:fs";
    await Bun.write("observed.json",JSON.stringify({list:process.env.BROWSER_SCRIPTS,retry:process.env.BROWSER_RETRY,source:readFileSync("scripts/ci-browser.sh","utf8")})); process.exit(${code});`);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "fork-browser.ts")], {
    cwd: dir, env: { ...process.env, FORK_BROWSER_EVENT: "workflow_dispatch", FORK_BROWSER_BASE: "" }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(code);
  expect(readFileSync(join(dir, "scripts/ci-browser.sh"), "utf8")).toBe(source);
  const observed = JSON.parse(readFileSync(join(dir, "observed.json"), "utf8"));
  expect(observed.list).toBe("scripts/fork-fixture-regression.ts");
  expect(observed.retry).toBe("0");
  expect(observed.source).toContain("run_script scripts/fork-fixture-regression.ts");
});
