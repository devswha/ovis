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
const SHA = "a".repeat(40);
const NEWER = "b".repeat(40);

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rust-heartbeat-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// Answers from the files in $FAKE_GH and logs every call. `run view` prints "<status> <attempt>": status-<id>
// when given, else completed once cancelled, with attempt-<id>, which an accepted rerun raises. cancel-lost and
// rerun-lost make GitHub act but the answer fail; rerun-fails refuses reruns; head-error fails the head lookup.
// seen-error holds the error a read of the variable fails with (else, without a seen file, GitHub's 404).
const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/sh
d="$FAKE_GH"
echo "$*" >> "$d/calls"
answer() { if [ -n "$jq" ]; then jq -r "$jq" "$1"; else cat "$1"; fi; }
attempt() { cat "$d/attempt-$1" 2>/dev/null || echo 1; }
case "$1 $2" in
  "variable set") exit 0 ;;
  "run cancel") touch "$d/cancelled-$3"; [ -f "$d/cancel-lost" ] && { echo "gh: connection reset" >&2; exit 1; }; exit 0 ;;
  "run view")
    if [ -f "$d/status-$3" ]; then echo "$(cat "$d/status-$3") $(attempt "$3")"
    elif [ -f "$d/cancelled-$3" ]; then echo "completed $(attempt "$3")"
    else echo "in_progress $(attempt "$3")"; fi
    exit 0 ;;
  "run rerun")
    [ -f "$d/rerun-fails" ] && { echo "gh: HTTP 422" >&2; exit 1; }
    echo $(( $(attempt "$3") + 1 )) > "$d/attempt-$3"; rm -f "$d/cancelled-$3" "$d/status-$3"
    [ -f "$d/rerun-lost" ] && { echo "gh: connection reset" >&2; exit 1; }; exit 0 ;;
esac
shift
[ "$1" = --paginate ] && shift
url="$1"; jq=""
[ "$2" = --jq ] && jq="$3"
case "$url" in
  */variables/CI_RUST_RUNNER_SEEN)
    if [ -f "$d/seen-error" ]; then cat "$d/seen-error" >&2; exit 1; fi
    [ -f "$d/seen" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    printf '{"value":"%s"}' "$(cat "$d/seen")" > "$d/.seen.json"; answer "$d/.seen.json" ;;
  */runners*) answer "$d/runners.json" ;;
  */pulls/*|*/branches/*) [ -f "$d/head-error" ] && { echo "gh: Server Error (HTTP 503)" >&2; exit 1; }; answer "$d/head-\${url##*/}.json" ;;
  */jobs*) id=\${url#*/runs/}; answer "$d/jobs-\${id%%/*}.json" ;;
  *status=queued*) answer "$d/queued.json" ;;
  *status=in_progress*) answer "$d/in_progress.json" ;;
  *) exit 1 ;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);

type Job = { name: string; status: string; labels: string[] };
type Run = { id: number; event?: string; path?: string; repoOf?: string; attempt?: number; pr?: number | null; head?: string; jobs: Job[] };
type State = {
  runnerLabels?: string[]; online?: boolean; seen?: number | string; seenError?: string;
  queued?: Run[]; inProgress?: Run[]; status?: Record<number, string>; flags?: string[];
};

const rust = (status = "queued", labels = ["self-hosted", label]): Job => ({ name: "Rust PTY host", status, labels });
const fast = (status = "queued", labels = ["self-hosted", label]): Job => ({ name: "Fast checks", status, labels });
const prOf = (run: Run) => (run.pr === undefined ? run.id * 10 : run.pr);
const branchOf = (run: Run) => `topic-${run.id}`;

function fakeGitHub(state: State): string {
  const dir = tempDir();
  const runner = (status: string, labels: string[]) => ({ status, labels: labels.map((name) => ({ name })) });
  writeFileSync(join(dir, "runners.json"), JSON.stringify({ runners: [
    runner("online", ["self-hosted", "self-hosted-ovis"]),
    runner(state.online ? "online" : "offline", state.runnerLabels ?? ["self-hosted", label]),
  ] }));
  if (state.seen !== undefined) writeFileSync(join(dir, "seen"), String(state.seen));
  if (state.seenError !== undefined) writeFileSync(join(dir, "seen-error"), state.seenError);
  for (const flag of state.flags ?? []) writeFileSync(join(dir, flag), "");
  const all = [...(state.queued ?? []), ...(state.inProgress ?? [])];
  for (const [file, runs] of [["queued", state.queued ?? []], ["in_progress", state.inProgress ?? []]] as const) {
    writeFileSync(join(dir, `${file}.json`), JSON.stringify({ workflow_runs: runs.map((run) => ({
      id: run.id, run_attempt: run.attempt ?? 1, head_sha: SHA, head_branch: branchOf(run),
      head_repository: { full_name: run.repoOf ?? repo }, path: run.path ?? ".github/workflows/ci.yml", event: run.event ?? "pull_request",
      pull_requests: prOf(run) === null ? [] : [{ number: prOf(run) }],
    })) }));
  }
  for (const run of all) {
    writeFileSync(join(dir, `jobs-${run.id}.json`), JSON.stringify({ jobs: run.jobs }));
    if (run.attempt !== undefined) writeFileSync(join(dir, `attempt-${run.id}`), String(run.attempt));
    writeFileSync(join(dir, `head-${prOf(run)}.json`), JSON.stringify({ head: { sha: run.head ?? SHA } }));
    writeFileSync(join(dir, `head-${branchOf(run)}.json`), JSON.stringify({ commit: { sha: run.head ?? SHA } }));
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
const cancel = (id: number) => `run cancel ${id} --repo ${repo}`;
const rerun = (id: number) => `run rerun ${id} --repo ${repo}`;

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
          { id: 8, event: "push", jobs: [rust("queued", ["Self-Hosted", "Self-Hosted-Ovis-Rust"])] },
        ],
        inProgress: [{ id: 7, jobs: [rust()] }],
      }));
      expect(status).toBe(0);
      expect(acted(calls)).toEqual([cancel(7), cancel(8), rerun(7), rerun(8)]);
      expect(calls).toContain(`api repos/${repo}/pulls/70 --jq .head.sha`);
      expect(calls).toContain(`api repos/${repo}/branches/topic-8 --jq .commit.sha`);
      expect(pending(stateDir)).toEqual([]);
    }
  });

  it("leaves a run alone unless its own Rust PTY host job waits on that label: other jobs, other workflows, forks, manual runs, third attempts, no pull request", () => {
    const { status, calls } = heartbeat(fakeGitHub({
      seen: stale,
      queued: [
        { id: 1, jobs: [fast(), rust("completed", ["ubuntu-24.04"])] },
        { id: 2, jobs: [rust("queued", ["ubuntu-24.04"])] },
        { id: 3, path: ".github/workflows/pty-sidecar.yml", jobs: [rust()] },
        { id: 4, repoOf: "someone/fork", jobs: [rust()] },
        { id: 5, event: "workflow_dispatch", jobs: [rust()] },
        { id: 6, attempt: 3, jobs: [rust()] },
        { id: 9, pr: null, jobs: [rust()] },
      ],
    }));
    expect(status).toBe(0);
    expect(acted(calls)).toEqual([]);
  });

  it("follows up a run whose cancel answer was lost, and one still cancelling, on later passes", () => {
    const github = fakeGitHub({ seen: stale, queued: [{ id: 7, jobs: [rust()] }], status: { 7: "in_progress" }, flags: ["cancel-lost"] });
    const first = heartbeat(github);
    expect(first.status).toBe(0);
    expect(acted(first.calls)).toEqual([cancel(7), cancel(7)]);
    expect(pending(first.stateDir)).toEqual(["run-7"]);
    rmSync(join(github, "cancel-lost"));
    writeFileSync(join(github, "status-7"), "completed");
    writeFileSync(join(github, "queued.json"), JSON.stringify({ workflow_runs: [] }));
    const second = heartbeat(github, first.stateDir);
    expect(acted(second.calls)).toEqual([rerun(7)]);
    expect(pending(second.stateDir)).toEqual([]);
  });

  it("runs a pending run again even once a Rust runner is back", () => {
    const github = fakeGitHub({ seen: stale, queued: [{ id: 7, jobs: [rust()] }], status: { 7: "in_progress" } });
    const first = heartbeat(github);
    writeFileSync(join(github, "status-7"), "completed");
    writeFileSync(join(github, "runners.json"), JSON.stringify({ runners: [{ status: "online", labels: [{ name: label }] }] }));
    expect(acted(heartbeat(github, first.stateDir).calls)).toEqual([rerun(7)]);
  });

  it("does not run again a run whose pull request or branch has moved on to another commit, and keeps it while that cannot be told", () => {
    for (const event of ["pull_request", "push"]) {
      const { calls, stateDir } = heartbeat(fakeGitHub({ seen: stale, queued: [{ id: 7, event, head: NEWER, jobs: [rust()] }] }));
      expect(acted(calls)).toEqual([cancel(7)]);
      expect(pending(stateDir)).toEqual([]);
    }
    const github = fakeGitHub({ seen: stale, queued: [{ id: 7, jobs: [rust()] }], flags: ["head-error"] });
    const unknown = heartbeat(github);
    expect(acted(unknown.calls)).toEqual([cancel(7)]);
    expect(pending(unknown.stateDir)).toEqual(["run-7"]);
    rmSync(join(github, "head-error"));
    expect(acted(heartbeat(github, unknown.stateDir).calls)).toEqual([rerun(7)]);
  });

  it("never runs a run again past the attempt it was cancelled on, even when the rerun's answer was lost", () => {
    const github = fakeGitHub({ seen: stale, queued: [{ id: 7, attempt: 2, jobs: [rust()] }], flags: ["rerun-lost"] });
    const first = heartbeat(github);
    expect(acted(first.calls)).toEqual([cancel(7), rerun(7)]);
    expect(pending(first.stateDir)).toEqual(["run-7"]);
    writeFileSync(join(github, "status-7"), "completed");
    writeFileSync(join(github, "queued.json"), JSON.stringify({ workflow_runs: [] }));
    const second = heartbeat(github, first.stateDir);
    expect(acted(second.calls)).toEqual([]);
    expect(second.stderr).toContain("run 7 is on attempt 3 already");
    expect(pending(second.stateDir)).toEqual([]);
  });

  it("says so and fails once a cancelled run could not be run again for 30 passes", () => {
    const github = fakeGitHub({ seen: stale, queued: [{ id: 7, jobs: [rust()] }], flags: ["rerun-fails"] });
    let pass = heartbeat(github);
    expect(pass.status).toBe(0);
    for (let n = 2; n < 30; n++) expect(heartbeat(github, pass.stateDir).status).toBe(0);
    pass = heartbeat(github, pass.stateDir);
    expect(pass.status).toBe(1);
    expect(pass.stderr).toContain("::error::run 7 was cancelled for its queued Rust PTY host job and could not be run again");
    expect(pending(pass.stateDir)).toEqual([]);
  });
});
