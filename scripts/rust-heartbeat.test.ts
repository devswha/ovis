import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Answers from files in $FAKE_GH and logs every call; a cancelled run reads as completed, as GitHub's soon does.
const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
case "$1 $2" in
  "variable set") exit 0 ;;
  "variable get") [ -f "$FAKE_GH/seen" ] && cat "$FAKE_GH/seen" && exit 0; exit 1 ;;
  "run cancel") touch "$FAKE_GH/cancelled-$3"; exit 0 ;;
  "run view") [ -f "$FAKE_GH/cancelled-$3" ] && echo completed || echo in_progress; exit 0 ;;
  "run rerun") exit 0 ;;
esac
case "$3" in
  */runners*) cat "$FAKE_GH/runners.json" ;;
  */jobs*) id=\${3#*/runs/}; cat "$FAKE_GH/jobs-\${id%%/*}.json" ;;
  *status=queued*) cat "$FAKE_GH/queued.json" ;;
  *status=in_progress*) cat "$FAKE_GH/in_progress.json" ;;
  *) exit 1 ;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);

type Run = { id: number; head?: string; attempt?: number; jobs: { status: string; labels: string[] }[] };
type State = { online?: boolean; seen?: number | string; queued?: Run[]; inProgress?: Run[] };

function heartbeat(state: State): { status: number | null; stderr: string; calls: string[] } {
  const dir = tempDir();
  const runner = (status: string, labels: string[]) => ({ status, labels: labels.map((name) => ({ name })) });
  writeFileSync(join(dir, "runners.json"), JSON.stringify({ runners: [
    runner("online", ["self-hosted", "self-hosted-ovis"]),
    runner(state.online ? "online" : "offline", ["self-hosted", label]),
  ] }));
  if (state.seen !== undefined) writeFileSync(join(dir, "seen"), String(state.seen));
  for (const [file, runs] of [["queued", state.queued ?? []], ["in_progress", state.inProgress ?? []]] as const) {
    writeFileSync(join(dir, `${file}.json`), JSON.stringify({ workflow_runs: runs.map((run) => ({ id: run.id, run_attempt: run.attempt ?? 1, head_repository: { full_name: run.head ?? repo } })) }));
    for (const run of runs) writeFileSync(join(dir, `jobs-${run.id}.json`), JSON.stringify({ jobs: run.jobs }));
  }
  const result = spawnSync("bash", [script], { encoding: "utf8", timeout: 10_000, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_GH: dir, HEARTBEAT_NOW: String(now) } });
  expect(result.error).toBeUndefined();
  const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : [];
  return { status: result.status, stderr: result.stderr, calls };
}

const rustQueued = { status: "queued", labels: ["self-hosted", label] };
const others = [{ status: "in_progress", labels: ["self-hosted", "self-hosted-ovis"] }, { status: "queued", labels: ["ubuntu-24.04"] }];
const actedOn = (calls: string[]) => calls.filter((call) => /^run (cancel|rerun) /.test(call));

describe.skipIf(process.platform === "win32")("Rust runners' heartbeat", () => {
  it("writes the time while a Rust runner is online, and touches no run", () => {
    const { status, calls } = heartbeat({ online: true, seen: now - 3_600, queued: [{ id: 7, jobs: [rustQueued] }] });
    expect(status).toBe(0);
    expect(calls).toContain(`variable set CI_RUST_RUNNER_SEEN --repo ${repo} --body ${now}`);
    expect(actedOn(calls)).toEqual([]);
  });

  it("writes nothing and moves no run while the last heartbeat is still within the route's limit and a minute", () => {
    for (const seen of [now - 30, now - 360]) {
      const { status, calls } = heartbeat({ seen, queued: [{ id: 7, jobs: [rustQueued] }] });
      expect(status).toBe(0);
      expect(calls.some((call) => call.startsWith("variable set"))).toBe(false);
      expect(actedOn(calls)).toEqual([]);
    }
  });

  it("cancels and runs again in full each run of this repository with a Rust job queued, once no Rust runner has been seen past that", () => {
    for (const seen of [now - 361, "", "never"]) {
      const { status, stderr, calls } = heartbeat({
        seen,
        queued: [{ id: 7, jobs: [rustQueued, ...others] }, { id: 8, jobs: others }],
        inProgress: [{ id: 9, attempt: 2, jobs: [{ status: "completed", labels: ["self-hosted", label] }, rustQueued] }, { id: 7, jobs: [rustQueued] }],
      });
      expect(status).toBe(0);
      expect(actedOn(calls)).toEqual([`run cancel 7 --repo ${repo}`, `run rerun 7 --repo ${repo}`, `run cancel 9 --repo ${repo}`, `run rerun 9 --repo ${repo}`]);
      expect(stderr).toContain("run 7 waits for runners labelled self-hosted-ovis-rust");
    }
  });

  it("matches the Rust label as GitHub does, ignoring case", () => {
    const { calls } = heartbeat({ seen: now - 3_600, queued: [{ id: 7, jobs: [{ status: "queued", labels: ["Self-Hosted", "Self-Hosted-Ovis-Rust"] }] }] });
    expect(actedOn(calls)).toEqual([`run cancel 7 --repo ${repo}`, `run rerun 7 --repo ${repo}`]);
  });

  it("never touches a fork's run, nor a run on its third attempt", () => {
    const { calls } = heartbeat({ seen: now - 3_600, queued: [{ id: 7, head: "someone/fork", jobs: [rustQueued] }, { id: 8, attempt: 3, jobs: [rustQueued] }] });
    expect(actedOn(calls)).toEqual([]);
    expect(calls.some((call) => call.includes("/runs/7/jobs") || call.includes("/runs/8/jobs"))).toBe(false);
  });
});
