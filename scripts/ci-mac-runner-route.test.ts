import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ci-mac-runner-route.sh", import.meta.url));
const repo = "devswha/ovis";
const mac = ["self-hosted", "self-hosted-ovis-mac"];
const now = Date.parse("2026-11-05T12:00:00Z") / 1000;

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-mac-runner-route-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// A fake `gh` that answers the Actions API from the JSON files in $FAKE_GH and logs each call; a
// missing file makes it fail like an API error.
const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
[ "$1" = api ] && [ "$2" = --paginate ] || exit 1
case "$3" in
  */jobs*) id=\${3#*/runs/}; f=jobs-\${id%%/*} ;;
  *status=in_progress*) f=in_progress ;;
  *status=queued*) f=queued ;;
  *) exit 1 ;;
esac
cat "$FAKE_GH/$f.json"
`);
chmodSync(join(bin, "gh"), 0o755);

type Job = { status: string; labels: string[]; created_at: string };
const minutesAgo = (minutes: number) => new Date((now - minutes * 60) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const job = (status: string, minutes = 1, labels = mac): Job => ({ status, labels, created_at: minutesAgo(minutes) });

/** Writes the API state: runs by status, each run's id mapped to its jobs. */
function actions(state: { in_progress?: Record<number, Job[]>; queued?: Record<number, Job[]> }): string {
  const dir = tempDir();
  for (const status of ["in_progress", "queued"] as const) {
    const runs = state[status] ?? {};
    writeFileSync(join(dir, `${status}.json`), JSON.stringify({ workflow_runs: Object.keys(runs).map((id) => ({ id: Number(id) })) }));
    for (const [id, jobs] of Object.entries(runs)) writeFileSync(join(dir, `jobs-${id}.json`), JSON.stringify({ jobs }));
  }
  return dir;
}

function route(env: Record<string, string>) {
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_GH: tempDir(), REPOSITORY: repo, ROUTE_NOW: String(now), RUNNER_SEEN: String(now - 60), ...env },
  });
  expect(result.error).toBeUndefined();
  return result;
}

function routed(env: Record<string, string>): unknown {
  const result = route(env);
  expect(result.status).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines.length).toBe(1);
  expect(lines[0]).toStartWith("macos=");
  return JSON.parse(lines[0]!.slice("macos=".length));
}

const apiCalled = (dir: string) => existsSync(join(dir, "calls")) && readFileSync(join(dir, "calls"), "utf8").length > 0;

describe.skipIf(process.platform === "win32")("CI Mac runner route", () => {
  const pr = { EVENT_NAME: "pull_request", HEAD_REPO: repo };
  const main = { EVENT_NAME: "push", REF: "refs/heads/main" };

  it("sends a same-repository pull request and a push to main to an idle Mac runner", () => {
    expect(routed({ ...pr, FAKE_GH: actions({}) })).toEqual(mac);
    expect(routed({ ...main, FAKE_GH: actions({}) })).toEqual(mac);
  });

  it("lets one job wait behind a running one, and goes hosted from the second", () => {
    expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [job("in_progress")] } }) })).toEqual(mac);
    expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [job("in_progress")] }, queued: { 2: [job("queued")] } }) })).toBe("macos-15");
    expect(routed({ ...pr, MAC_MAX_JOBS: "3", FAKE_GH: actions({ in_progress: { 1: [job("in_progress")] }, queued: { 2: [job("queued")] } }) })).toEqual(mac);
  });

  it("goes hosted when a job has waited too long for the Mac runner (offline)", () => {
    expect(routed({ ...pr, FAKE_GH: actions({ queued: { 1: [job("queued", 11)] } }) })).toBe("macos-15");
    expect(routed({ ...pr, MAC_STALE_MINUTES: "15", FAKE_GH: actions({ queued: { 1: [job("queued", 11)] } }) })).toEqual(mac);
    // a long-running job is busy, not offline
    expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [job("in_progress", 30)] } }) })).toEqual(mac);
  });

  it("goes hosted unless the heartbeat saw the Mac runner online in the last five minutes", () => {
    for (const seen of ["", " ", "soon", String(now - 301), String(now + 3600)]) {
      const dir = actions({});
      expect(routed({ ...pr, RUNNER_SEEN: seen, FAKE_GH: dir })).toBe("macos-15");
      expect(apiCalled(dir)).toBe(false);
    }
    expect(routed({ ...pr, RUNNER_SEEN: String(now - 300), FAKE_GH: actions({}) })).toEqual(mac);
    expect(routed({ ...pr, RUNNER_SEEN: String(now - 600), MAC_SEEN_SECONDS: "900", FAKE_GH: actions({}) })).toEqual(mac);
  });

  it("ignores finished jobs and jobs for other runners", () => {
    const others = [job("completed", 30), job("queued", 30, ["self-hosted", "self-hosted-ovis"]), job("queued", 30, ["macos-15"])];
    expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: others }, queued: { 2: others } }) })).toEqual(mac);
    expect(routed({ ...pr, FAKE_GH: actions({ queued: { 1: [job("queued", 30, ["Self-Hosted", "SELF-HOSTED-OVIS-MAC"])] } }) })).toBe("macos-15");
  });

  it("stays hosted when the Actions API fails", () => {
    const failing = tempDir();
    const result = route({ ...pr, FAKE_GH: failing });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('macos="macos-15"');
    expect(result.stderr).toContain("::warning::");
  });

  it("never sends a fork, a tag, a dispatch or another event to the Mac, and asks the API nothing", () => {
    for (const env of [
      { EVENT_NAME: "pull_request", HEAD_REPO: "someone/ovis" },
      { EVENT_NAME: "pull_request_target", HEAD_REPO: "" },
      { EVENT_NAME: "push", REF: "refs/tags/remote-v9" },
      { EVENT_NAME: "push", REF: "refs/heads/feature" },
      { EVENT_NAME: "workflow_dispatch", REF: "refs/heads/main" },
      { EVENT_NAME: "workflow_run", HEAD_REPO: repo },
      { EVENT_NAME: "" },
    ]) {
      const dir = actions({});
      expect(routed({ ...env, FAKE_GH: dir })).toBe("macos-15");
      expect(apiCalled(dir)).toBe(false);
    }
  });

  it("keeps everything hosted while the variable says macos-15, and refuses any other value", () => {
    const dir = actions({});
    expect(routed({ ...pr, CONFIGURED_LABELS: ' "macos-15" ', FAKE_GH: dir })).toBe("macos-15");
    expect(apiCalled(dir)).toBe(false);
    for (const value of ['["self-hosted"]', "macos-15", '"ubuntu-24.04"']) {
      const result = route({ ...pr, CONFIGURED_LABELS: value, FAKE_GH: actions({}) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("::error::");
    }
  });

  it("refuses limits that are not whole numbers", () => {
    for (const env of [{ MAC_MAX_JOBS: "two" }, { MAC_STALE_MINUTES: "-1" }, { MAC_STALE_MINUTES: "99999" }, { MAC_SEEN_SECONDS: "5m" }]) {
      expect(route({ ...pr, ...env, FAKE_GH: actions({}) }).status).toBe(1);
    }
  });
});
