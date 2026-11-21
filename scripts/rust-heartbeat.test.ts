import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./self-hosted-runner/rust-heartbeat.sh", import.meta.url));
const repo = "devswha/ovis";
const label = "self-hosted-ovis-rust";
const now = 2_000_000_000;

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rust-heartbeat-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// Answers from the files in $FAKE_GH and logs every call. A run reads as completed once cancelled, unless a
// status-<id> file says otherwise; seen-error holds the error a read of the variable fails with (else, without
// a seen file, GitHub's 404 for a missing variable).
const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
answer() { if [ -n "$jq" ]; then jq -r "$jq" "$1"; else cat "$1"; fi; }
case "$1 $2" in
  "variable set") exit 0 ;;
  "run cancel") touch "$FAKE_GH/cancelled-$3"; exit 0 ;;
  "run view")
    if [ -f "$FAKE_GH/status-$3" ]; then cat "$FAKE_GH/status-$3"; elif [ -f "$FAKE_GH/cancelled-$3" ]; then echo completed; else echo in_progress; fi
    exit 0 ;;
  "run rerun") [ -f "$FAKE_GH/rerun-fails" ] && { echo "gh: HTTP 422" >&2; exit 1; }; exit 0 ;;
esac
shift
[ "$1" = --paginate ] && shift
url="$1"; jq=""
[ "$2" = --jq ] && jq="$3"
case "$url" in
  */variables/CI_RUST_RUNNER_SEEN)
    if [ -f "$FAKE_GH/seen-error" ]; then cat "$FAKE_GH/seen-error" >&2; exit 1; fi
    [ -f "$FAKE_GH/seen" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    printf '{"value":"%s"}' "$(cat "$FAKE_GH/seen")" > "$FAKE_GH/.seen.json"; answer "$FAKE_GH/.seen.json" ;;
  */runners*) answer "$FAKE_GH/runners.json" ;;
  */workflows/ci.yml/runs*) b=\${url#*branch=}; b=\${b%%&*}; answer "$FAKE_GH/newest-$b.json" ;;
  */jobs*) id=\${url#*/runs/}; answer "$FAKE_GH/jobs-\${id%%/*}.json" ;;
  *status=queued*) answer "$FAKE_GH/queued.json" ;;
  *status=in_progress*) answer "$FAKE_GH/in_progress.json" ;;
  *) exit 1 ;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);

type Job = { name: string; status: string; labels: string[] };
type Run = { id: number; branch?: string; event?: string; path?: string; head?: string; attempt?: number; jobs: Job[] };
type State = { runnerLabels?: string[]; online?: boolean; seen?: number | string; seenError?: string; queued?: Run[]; inProgress?: Run[]; newest?: Record<string, number>; status?: Record<number, string>; rerunFails?: boolean };

const rust = (status = "queued", labels = ["self-hosted", label]): Job => ({ name: "Rust PTY host", status, labels });
const fast = (status = "queued", labels = ["self-hosted", label]): Job => ({ name: "Fast checks", status, labels });

function fakeGitHub(state: State): string {
  const dir = tempDir();
  const runner = (status: string, labels: string[]) => ({ status, labels: labels.map((name) => ({ name })) });
  writeFileSync(join(dir, "runners.json"), JSON.stringify({ runners: [
    runner("online", ["self-hosted", "self-hosted-ovis"]),
    runner(state.online ? "online" : "offline", state.runnerLabels ?? ["self-hosted", label]),
  ] }));
  if (state.seen !== undefined) writeFileSync(join(dir, "seen"), String(state.seen));
  if (state.seenError !== undefined) writeFileSync(join(dir, "seen-error"), state.seenError);
  if (state.rerunFails) writeFileSync(join(dir, "rerun-fails"), "");
  const all = [...(state.queued ?? []), ...(state.inProgress ?? [])];
  for (const [file, runs] of [["queued", state.queued ?? []], ["in_progress", state.inProgress ?? []]] as const) {
    writeFileSync(join(dir, `${file}.json`), JSON.stringify({ workflow_runs: runs.map((run) => ({
      id: run.id, run_attempt: run.attempt ?? 1, head_repository: { full_name: run.head ?? repo },
      path: run.path ?? ".github/workflows/ci.yml", event: run.event ?? "pull_request", head_branch: run.branch ?? `topic-${run.id}`,
    })) }));
  }
  for (const run of all) {
    writeFileSync(join(dir, `jobs-${run.id}.json`), JSON.stringify({ jobs: run.jobs }));
    const branch = run.branch ?? `topic-${run.id}`;
    writeFileSync(join(dir, `newest-${branch}.json`), JSON.stringify({ workflow_runs: [{ id: state.newest?.[run.id] ?? run.id }] }));
  }
  for (const [id, status] of Object.entries(state.status ?? {})) writeFileSync(join(dir, `status-${id}`), status);
  return dir;
}

function heartbeat(github: string, stateDir = tempDir()): { status: number | null; stderr: string; calls: string[]; stateDir: string } {
  rmSync(join(github, "calls"), { force: true });
  const result = spawnSync("bash", [script], { encoding: "utf8", timeout: 10_000, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_GH: github, HEARTBEAT_NOW: String(now), STATE_DIR: stateDir } });
  expect(result.error).toBeUndefined();
  const calls = existsSync(join(github, "calls")) ? readFileSync(join(github, "calls"), "utf8").trim().split("\n") : [];
  return { status: result.status, stderr: result.stderr, calls, stateDir };
}

const acted = (calls: string[]) => calls.filter((call) => /^run (cancel|rerun) /.test(call));
const pending = (stateDir: string) => readdirSync(stateDir).filter((name) => name.startsWith("run-")).sort();
const stale = now - 3_600;

describe.skipIf(process.platform === "win32")("Rust runners' heartbeat", () => {
  it("writes the time while a Rust runner is online, whatever the case of its label, and cancels nothing", () => {
    for (const labels of [["self-hosted", label], ["Self-Hosted", "Self-Hosted-Ovis-Rust"]]) {
      const { status, calls } = heartbeat(fakeGitHub({ online: true, runnerLabels: labels, seen: stale, queued: [{ id: 7, jobs: [rust()] }] }));
      expect(status).toBe(0);
      expect(calls).toContain(`variable set CI_RUST_RUNNER_SEEN --repo ${repo} --body ${now}`);
      expect(acted(calls)).toEqual([]);
    }
  });

  it("moves no run while the last heartbeat is within the route's limit and a minute, or the variable cannot be read", () => {
    for (const state of [{ seen: now - 30 }, { seen: now - 360 }, { seenError: "gh: Server Error (HTTP 503)" }]) {
      const { status, calls } = heartbeat(fakeGitHub({ ...state, queued: [{ id: 7, jobs: [rust()] }] }));
      expect(status).toBe("seenError" in state ? 1 : 0);
      expect(calls.some((call) => call.startsWith("variable set"))).toBe(false);
      expect(acted(calls)).toEqual([]);
    }
  });

  it("cancels and runs again each CI run whose Rust PTY host job is queued on the Rust label, once no Rust runner has been seen past that", () => {
    for (const seen of [now - 361, "never", undefined]) {
      const { status, calls, stateDir } = heartbeat(fakeGitHub({
        seen,
        queued: [
          { id: 7, jobs: [rust(), fast("in_progress", ["self-hosted", "self-hosted-ovis"])] },
          { id: 8, event: "push", branch: "main", jobs: [rust("queued", ["Self-Hosted", "Self-Hosted-Ovis-Rust"])] },
        ],
        inProgress: [{ id: 7, jobs: [rust()] }],
      }));
      expect(status).toBe(0);
      expect(acted(calls)).toEqual([`run cancel 7 --repo ${repo}`, `run cancel 8 --repo ${repo}`, `run rerun 7 --repo ${repo}`, `run rerun 8 --repo ${repo}`]);
      expect(pending(stateDir)).toEqual([]);
    }
  });

  it("leaves a run alone unless its own Rust PTY host job waits on that label: other jobs, other workflows, forks, manual runs, third attempts", () => {
    const { status, calls } = heartbeat(fakeGitHub({
      seen: stale,
      queued: [
        { id: 1, jobs: [fast(), rust("completed", ["ubuntu-24.04"])] },
        { id: 2, jobs: [rust("queued", ["ubuntu-24.04"])] },
        { id: 3, path: ".github/workflows/pty-sidecar.yml", jobs: [rust()] },
        { id: 4, head: "someone/fork", jobs: [rust()] },
        { id: 5, event: "workflow_dispatch", jobs: [rust()] },
        { id: 6, attempt: 3, jobs: [rust()] },
      ],
    }));
    expect(status).toBe(0);
    expect(acted(calls)).toEqual([]);
  });

  it("keeps a cancelled run until it has completed, and runs it again on a later pass", () => {
    const github = fakeGitHub({ seen: stale, queued: [{ id: 7, jobs: [rust()] }], status: { 7: "in_progress" } });
    const first = heartbeat(github);
    expect(acted(first.calls)).toEqual([`run cancel 7 --repo ${repo}`]);
    expect(pending(first.stateDir)).toEqual(["run-7"]);
    writeFileSync(join(github, "status-7"), "completed");
    writeFileSync(join(github, "queued.json"), JSON.stringify({ workflow_runs: [] }));
    const second = heartbeat(github, first.stateDir);
    expect(acted(second.calls)).toEqual([`run rerun 7 --repo ${repo}`]);
    expect(pending(second.stateDir)).toEqual([]);
  });

  it("runs a pending run again even once a Rust runner is back", () => {
    const github = fakeGitHub({ seen: stale, queued: [{ id: 7, jobs: [rust()] }], status: { 7: "in_progress" } });
    const first = heartbeat(github);
    writeFileSync(join(github, "status-7"), "completed");
    writeFileSync(join(github, "runners.json"), JSON.stringify({ runners: [{ status: "online", labels: [{ name: label }] }] }));
    expect(acted(heartbeat(github, first.stateDir).calls)).toEqual([`run rerun 7 --repo ${repo}`]);
  });

  it("cancels but does not run again a run a newer CI run of its branch has superseded", () => {
    const { status, calls, stateDir } = heartbeat(fakeGitHub({ seen: stale, queued: [{ id: 7, jobs: [rust()] }], newest: { 7: 9 } }));
    expect(status).toBe(0);
    expect(acted(calls)).toEqual([`run cancel 7 --repo ${repo}`]);
    expect(pending(stateDir)).toEqual([]);
  });

  it("says so and fails once a cancelled run could not be run again for 30 passes", () => {
    const github = fakeGitHub({ seen: stale, queued: [{ id: 7, jobs: [rust()] }], rerunFails: true });
    let pass = heartbeat(github);
    expect(pass.status).toBe(0);
    expect(pending(pass.stateDir)).toEqual(["run-7"]);
    writeFileSync(join(pass.stateDir, "run-7"), "topic-7 pull_request 28\n");
    pass = heartbeat(github, pass.stateDir);
    expect(pass.status).toBe(0);
    pass = heartbeat(github, pass.stateDir);
    expect(pass.status).toBe(1);
    expect(pass.stderr).toContain("::error::run 7 was cancelled for its queued Rust PTY host job and could not be run again");
    expect(pending(pass.stateDir)).toEqual([]);
  });
});
