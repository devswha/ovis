import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, truthy, type Value } from "./workflow-expression.ts";
import { parseWorkflow, root, type Job } from "./shell-workflow-rules.ts";

const workflow = parseWorkflow(join(root, ".github/workflows/remote-bundles.yml"));
const STATUS = /\b(always|success|failure|cancelled)\s*\(/;
const needsOf = (job: Job): string[] => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);

// Which jobs a run of this event starts, every job passing: a job without a status function in its condition also
// waits, as GitHub's implicit success() does, for every job before it, however far back, to pass.
function ran(event: string, ref: string): Record<string, Job> {
  const results: Record<string, string> = {};
  const allPassed = (id: string): boolean => results[id] === "success" && needsOf(workflow.jobs[id]!).every(allPassed);
  const settle = (id: string): string => {
    if (results[id] !== undefined) return results[id]!;
    const job = workflow.jobs[id]!;
    const needs: Record<string, Value> = Object.fromEntries(needsOf(job).map((need) => [need, { result: settle(need) }]));
    const passed = needsOf(job).every(allPassed);
    const condition = job.if === undefined ? true : truthy(evaluate(job.if, { github: { event_name: event, ref, repository: "devswha/ovis" }, needs }));
    results[id] = condition && (job.if !== undefined && STATUS.test(job.if) ? true : passed) ? "success" : "skipped";
    return results[id]!;
  };
  return Object.fromEntries(Object.keys(workflow.jobs).filter((id) => settle(id) === "success").map((id) => [id, workflow.jobs[id]!]));
}

const withScripts = (run: string): string => [run, ...[...run.matchAll(/\bscripts\/[\w-]+\.sh\b/g)].map((match) => readFileSync(join(root, match[0]), "utf8"))].join("\n");
const sshParts = (job: Job): string[] => (job.steps ?? []).flatMap((step) => [...(step.run ?? "").matchAll(/scripts\/ci-ssh-checks\.sh (\w+)/g)].map((match) => match[1]!));
const checks = (jobs: Record<string, Job>): string[] => [...new Set(Object.values(jobs).flatMap((job) => (job.steps ?? []).map((step) => withScripts(step.run ?? "")).flatMap((run) => [...run.matchAll(/scripts\/(remote-bundle-smoke|ssh-integration|ssh-password-docker)\.ts|server\/windows-native\.test\.ts/g)].map((match) => match[0]))))].sort();
const smokedOn = (jobs: Record<string, Job>): string[] => Object.entries(jobs).filter(([, job]) => (job.steps ?? []).some((step) => (step.run ?? "").includes("scripts/remote-bundle-smoke.ts"))).map(([, job]) => String(job["runs-on"])).sort();

describe("remote-bundles.yml", () => {
  const PULL_REQUEST = ran("pull_request", "refs/pull/1/merge");
  const EVERY_CHECK = ["scripts/remote-bundle-smoke.ts", "scripts/ssh-integration.ts", "scripts/ssh-password-docker.ts", "server/windows-native.test.ts"];

  it("runs a pull request's checks on two GitHub-hosted runners: Linux builds both bundles and runs the SSH flows, Windows smokes its bundle", () => {
    expect(Object.keys(PULL_REQUEST).sort()).toEqual(["bundle-linux", "smoke-windows"]);
    expect(checks(PULL_REQUEST)).toEqual(EVERY_CHECK);
    expect(smokedOn(PULL_REQUEST)).toEqual(["ubuntu-24.04", "windows-latest"]);
    const linux = PULL_REQUEST["bundle-linux"]!.steps!;
    const windowsBuild = linux.findIndex((step) => (step.run ?? "").includes("build-remote-bundle.ts win32-x64"));
    const upload = linux.findIndex((step) => step.with?.["name"] === "remote-win32-x64");
    expect(windowsBuild).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(windowsBuild);
    expect(linux[upload]!.with?.["path"]).toBe(`${linux[windowsBuild]!.env?.["HERDR_BUNDLE_OUTPUT"]}/*`);
    expect(sshParts(PULL_REQUEST["bundle-linux"]!)).toEqual(["server", "integration", "password"]);
    expect(sshParts(workflow.jobs["ssh"]!)).toEqual(["server", "integration", "password"]);
    expect(linux.findIndex((step) => (step.run ?? "").includes("ci-ssh-checks.sh server"))).toBeGreaterThan(linux.findIndex((step) => (step.run ?? "").includes("remote-bundle-smoke.ts")));
  });

  it.each([["workflow_dispatch", "refs/heads/main"], ["push", "refs/tags/remote-v9.9.9"]])("keeps every job of a %s run as it was", (event, ref) => {
    const jobs = ran(event, ref);
    expect(Object.keys(jobs).sort()).toEqual(["bundle", "bundle-windows", ...(event === "push" ? ["release"] : []), "smoke-windows", "ssh"]);
    expect(checks(jobs)).toEqual(EVERY_CHECK);
  });

  it("smokes on Windows the bundle its own run assembled, and skips it when that build failed", () => {
    const smoke = workflow.jobs["smoke-windows"]!;
    const decide = (event: string, linux: string, windows: string): boolean => truthy(evaluate(smoke.if!, { github: { event_name: event }, needs: { "bundle-linux": { result: linux }, "bundle-windows": { result: windows } } }));
    expect(decide("pull_request", "success", "skipped")).toBe(true);
    expect(decide("pull_request", "failure", "skipped")).toBe(false);
    expect(decide("push", "skipped", "success")).toBe(true);
    expect(decide("push", "skipped", "failure")).toBe(false);
  });

  it("publishes a tag's bundles only when every job it needs passed", () => {
    const release = workflow.jobs["release"]!;
    const passed = { bundle: { result: "success" }, "smoke-windows": { result: "success" }, ssh: { result: "success" } };
    const decide = (ref: string, needs: Record<string, Value>): boolean => truthy(evaluate(release.if!, { github: { ref }, needs: { ...passed, ...needs } }));
    expect(decide("refs/tags/remote-v9.9.9", {})).toBe(true);
    expect(decide("refs/heads/main", {})).toBe(false);
    for (const need of Object.keys(passed)) for (const result of ["failure", "skipped", "cancelled"]) expect([need, result, decide("refs/tags/remote-v9.9.9", { [need]: { result } })]).toEqual([need, result, false]);
  });

  // GitHub's paths filter: the last pattern a path matches decides, and a pattern starting with ! leaves the path out.
  const triggers = (path: string): boolean => {
    let matched = false;
    for (const pattern of (workflow.on["pull_request"] as { paths: string[] }).paths) {
      const negated = pattern.startsWith("!");
      if (new Bun.Glob(negated ? pattern.slice(1) : pattern).match(path)) matched = !negated;
    }
    return matched;
  };

  it("leaves out a pull request that changes only the server's unit tests or notes, which no bundle carries", () => {
    for (const path of ["server/store.test.ts", "server/relay/service.test.ts", "server/machine-api.contract.test.ts", "shared/protocol.test.ts", "server/AGENTS.md"]) expect([path, triggers(path)]).toEqual([path, false]);
    for (const path of ["server/index.ts", "server/relay/service.ts", "server/machine-profile.test-helpers.ts", "server/fixtures/prompt.txt", "shared/protocol.ts", "server/windows-native.test.ts", "bun.lock", ".github/workflows/remote-bundles.yml"]) expect([path, triggers(path)]).toEqual([path, true]);
  });
});
