import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ci-runner-route.sh", import.meta.url));
const labels = '["self-hosted","linux","x64","herdr-ci"]';
const repo = "devswha/ovis";

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-runner-route-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// A fake `gh` that answers the Actions API from the JSON files in $FAKE_GH and logs each call; a
// missing file makes it fail like an API error, and a `fail-<file>` beside one makes the next call
// for it print part of its answer and then fail, as a 502 on a later page does; a `refuse-<file>`
// makes every call for it fail as the API's refusal (HTTP 404) does. With $ROUTE_TEST_SECONDS_FILE set (the route's
// test seam for the seconds it has run), each call moves that file on by $FAKE_CALL_SECONDS: a read that takes time,
// with no time spent.
const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
if [ -n "$ROUTE_TEST_SECONDS_FILE" ]; then echo $(( $(cat "$ROUTE_TEST_SECONDS_FILE") + FAKE_CALL_SECONDS )) > "$ROUTE_TEST_SECONDS_FILE"; fi
[ "$1" = api ] && [ "$2" = --paginate ] || exit 1
case "$3" in
  */jobs*) id=\${3#*/runs/}; f=jobs-\${id%%/*} ;;
  *status=in_progress*) f=in_progress ;;
  *status=queued*) f=queued ;;
  *) exit 1 ;;
esac
if [ -f "$FAKE_GH/refuse-$f" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
if [ -f "$FAKE_GH/fail-$f" ]; then rm "$FAKE_GH/fail-$f"; cat "$FAKE_GH/$f.json"; echo "gh: Server Error (HTTP 502)" >&2; exit 1; fi
cat "$FAKE_GH/$f.json"
`);
chmodSync(join(bin, "gh"), 0o755);
// `date +%s` answers $FAKE_NOW (`fail` fails) when it is set, so a heartbeat's age is exact; anything else is the real
// date
writeFileSync(join(bin, "date"), `#!/bin/sh
if [ "$*" = +%s ]; then
  if [ "$FAKE_NOW" = fail ]; then exit 1; fi
  if [ -n "$FAKE_NOW" ]; then echo "$FAKE_NOW"; exit 0; fi
fi
PATH=\${PATH#*:} exec date "$@"
`);
chmodSync(join(bin, "date"), 0o755);
// `jq` fails, as a process that could not start would, for the one call that names $FAKE_JQ_FAIL among its arguments
writeFileSync(join(bin, "jq"), `#!/bin/sh
if [ -n "$FAKE_JQ_FAIL" ]; then for arg in "$@"; do [ "$arg" = "$FAKE_JQ_FAIL" ] && exit 5; done; fi
PATH=\${PATH#*:} exec jq "$@"
`);
chmodSync(join(bin, "jq"), 0o755);

type Job = { status: string; labels: string[]; name?: string };
const ovis = ["self-hosted", "self-hosted-ovis"];
const running = (count: number, labels = ovis): Job[] => Array.from({ length: count }, () => ({ status: "in_progress", labels }));
const waiting = (count: number, labels = ovis): Job[] => Array.from({ length: count }, () => ({ status: "queued", labels }));

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
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_GH: tempDir(), REPOSITORY: repo, ...env },
  });
  expect(result.error).toBeUndefined();
  return result;
}

/** The two outputs: linux= for the Linux jobs, then fast= for Fast checks. */
function outputs(env: Record<string, string>): { linux: unknown; fast: unknown } {
  const result = route(env);
  expect(result.status).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines.length).toBe(2);
  expect(lines[0]).toStartWith("linux=");
  expect(lines[1]).toStartWith("fast=");
  return { linux: JSON.parse(lines[0]!.slice("linux=".length)), fast: JSON.parse(lines[1]!.slice("fast=".length)) };
}

function routed(env: Record<string, string>): unknown {
  return outputs(env).linux;
}

describe.skipIf(process.platform === "win32")("CI runner route", () => {
  it("routes a push to the maintainer PC's runners without the variable", () => {
    expect(routed({ EVENT_NAME: "push" })).toEqual(["self-hosted", "self-hosted-ovis"]);
  });

  it("keeps any other event hosted without the variable", () => {
    for (const event of ["workflow_dispatch", "workflow_run", "merge_group", "schedule", ""]) {
      expect(routed({ EVENT_NAME: event, HEAD_REPO: repo })).toBe("ubuntu-24.04");
    }
  });

  describe("a same-repository pull request without the variable", () => {
    const pr = { EVENT_NAME: "pull_request", HEAD_REPO: repo };

    it("goes to the self-hosted runners while they have room for its jobs", () => {
      expect(routed({ ...pr, FAKE_GH: actions({}) })).toEqual(ovis);
      // 4 of 10 busy leaves exactly the 6 Linux jobs one run needs
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(2) }, queued: { 2: waiting(2) } }) })).toEqual(ovis);
    });

    it("goes hosted when queued and running jobs leave too little room", () => {
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(2), 3: [...running(1), ...waiting(1)] }, queued: { 2: waiting(1) } }) }))
        .toBe("ubuntu-24.04");
      // stops asking once the runners are known to be full: run 2's jobs are never read
      const full = actions({ in_progress: { 1: running(7), 2: running(1) } });
      rmSync(join(full, "jobs-2.json"));
      const result = route({ ...pr, FAKE_GH: full });
      expect(result.stdout).toBe('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\n');
      expect(result.stderr).not.toContain("::warning::");
    });

    it("counts only unfinished jobs on the pull requests' runners", () => {
      const others: Job[] = [
        ...running(3, ["self-hosted", "self-hosted-ovis-main"]),
        ...running(3, ["ubuntu-24.04"]),
        { status: "completed", labels: ovis },
        { status: "completed", labels: ovis },
      ];
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [...others, ...running(4, ["Self-Hosted", "self-hosted-ovis"])] } }) }))
        .toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [...others, ...running(7)] } }) })).toBe("ubuntu-24.04");
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(7, ["self-hosted-ovis"]) } }) })).toEqual(ovis);
      // a job asking for fewer labels can take those runners too
      for (const labels of [["self-hosted"], ["self-hosted", "linux", "x64"]]) {
        expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(7, labels) } }) })).toBe("ubuntu-24.04");
      }
    });

    it("leaves the light jobs out of the count", () => {
      const light = ["Detect changes", "herdr-core live contract", "Integration and browser", "Pull request title", "bundle-windows"]
        .map((name): Job => ({ status: "in_progress", labels: ovis, name }));
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [...running(4), ...light] } }) })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [...running(4), { status: "in_progress", labels: ovis, name: "Fast checks" }] } }) }))
        .toBe("ubuntu-24.04");
    });

    it("counts the jobs on every page", () => {
      const state = actions({ in_progress: { 1: running(1) } });
      const page = (jobs: Job[]) => JSON.stringify({ jobs });
      writeFileSync(join(state, "jobs-1.json"), `${page(running(4))}\n${page(running(3))}\n`);
      writeFileSync(join(state, "in_progress.json"), `{"workflow_runs":[]}\n{"workflow_runs":[{"id":1}]}\n`);
      // counted, not a failed count falling back to hosted
      const result = route({ ...pr, FAKE_GH: state });
      expect(result.stdout).toBe('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\n');
      expect(result.stderr).toContain("at least 7 of 10");
      expect(result.stderr).not.toContain("::warning::");
    });

    it("takes the capacity from CI_SELF_HOSTED_CAPACITY", () => {
      expect(routed({ ...pr, FAKE_GH: actions({}), SELF_HOSTED_CAPACITY: "6" })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({}), SELF_HOSTED_CAPACITY: "5" })).toBe("ubuntu-24.04");
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(8) } }), SELF_HOSTED_CAPACITY: "14" })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({}), SELF_HOSTED_CAPACITY: "08" })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(4) } }), SELF_HOSTED_CAPACITY: "010" })).toEqual(ovis);
      for (const value of ["ten", "-1", "4.5", "99999999999999999999"]) {
        const result = route({ ...pr, FAKE_GH: actions({}), SELF_HOSTED_CAPACITY: value });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("::error::repository variable CI_SELF_HOSTED_CAPACITY");
      }
    });

    it("stays hosted when the jobs cannot be counted", () => {
      const result = route(pr);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\n');
      expect(result.stderr).toContain("::warning::");
      const broken = actions({ in_progress: { 1: running(1) } });
      rmSync(join(broken, "jobs-1.json"));
      expect(routed({ ...pr, FAKE_GH: broken })).toBe("ubuntu-24.04");
    });

    it("asks again when one read fails, and counts what it then reads once", () => {
      // 10 running of 16 leave room for the run's 6 jobs; each part counted twice would leave none
      const flaky = actions({ in_progress: { 1: running(5) }, queued: { 2: running(5) } });
      for (const file of ["in_progress", "jobs-1", "jobs-2"]) writeFileSync(join(flaky, `fail-${file}`), "");
      expect(routed({ ...pr, SELF_HOSTED_CAPACITY: "16", FAKE_GH: flaky })).toEqual(JSON.parse('["self-hosted","self-hosted-ovis"]'));
    });

    it("does not ask again what the API refused", () => {
      const refused = actions({ in_progress: { 1: running(1) } });
      writeFileSync(join(refused, "refuse-jobs-1"), "");
      expect(routed({ ...pr, FAKE_GH: refused })).toBe("ubuntu-24.04");
      const calls = readFileSync(join(refused, "calls"), "utf8").trim().split("\n");
      expect(calls.filter((call) => call.includes("/runs/1/jobs"))).toHaveLength(1);
    });

    it("never asks the API for a fork, a configured label set or the hosted override", () => {
      for (const env of [
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" },
        { ...pr, CONFIGURED_LABELS: labels },
        { ...pr, CONFIGURED_LABELS: '"ubuntu-24.04"' },
      ]) {
        const state = actions({});
        route({ ...env, FAKE_GH: state });
        expect(existsSync(join(state, "calls"))).toBe(false);
      }
      expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", FAKE_GH: actions({}) })).toBe("ubuntu-24.04");
    });
  });

  it("keeps everything on the GitHub-hosted image when the variable names it", () => {
    const hosted = '"ubuntu-24.04"';
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: hosted })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "push", CONFIGURED_LABELS: hosted })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels, CONFIGURED_LABELS: hosted })).toEqual(JSON.parse(labels));
  });

  describe("CI_LINUX_SELF_HOSTED_LABELS", () => {
    const vm = '["self-hosted","ovis-vm"]';

    it("moves the Linux jobs of a push and of a same-repository pull request", () => {
      expect(routed({ EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: vm })).toEqual(["self-hosted", "ovis-vm"]);
      expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, LINUX_LABELS: vm })).toEqual(["self-hosted", "ovis-vm"]);
      const result = route({ EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: vm });
      expect(result.stderr).toContain("from repository variable CI_LINUX_SELF_HOSTED_LABELS");
    });

    it("leaves a tag push, a manual run and a workflow that calls ci.yml on CI_SELF_HOSTED_LABELS' routing", () => {
      expect(routed({ EVENT_NAME: "push", REF: "refs/tags/v1.2.3", LINUX_LABELS: vm })).toEqual(["self-hosted", "self-hosted-ovis"]);
      expect(routed({ EVENT_NAME: "workflow_dispatch", LINUX_LABELS: vm })).toBe("ubuntu-24.04");
      expect(routed({ EVENT_NAME: "workflow_dispatch", LINUX_LABELS: vm, CONFIGURED_LABELS: '["self-hosted","self-hosted-ovis"]' })).toEqual(["self-hosted", "self-hosted-ovis"]);
    });

    it("never moves a fork pull request", () => {
      expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", LINUX_LABELS: vm })).toBe("ubuntu-24.04");
    });
  });

  describe("Fast checks", () => {
    const vm = '["self-hosted","ovis-vm"]';
    const pc = '["self-hosted","self-hosted-ovis"]';

    it("of a manual run that names ovis-vm stay with the rest", () => {
      expect(outputs({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: vm, FAST_LABELS: pc })).toEqual({ linux: ["self-hosted", "ovis-vm"], fast: ["self-hosted", "ovis-vm"] });
    });

    it("follow the Linux jobs when CI_FAST_SELF_HOSTED_LABELS is unset", () => {
      expect(outputs({ EVENT_NAME: "push", CONFIGURED_LABELS: vm })).toEqual({ linux: ["self-hosted", "ovis-vm"], fast: ["self-hosted", "ovis-vm"] });
    });

    it("take CI_FAST_SELF_HOSTED_LABELS when the Linux jobs go to the VM runners", () => {
      expect(outputs({ EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: vm, FAST_LABELS: pc }))
        .toEqual({ linux: ["self-hosted", "ovis-vm"], fast: ["self-hosted", "self-hosted-ovis"] });
    });

    it("ignore CI_FAST_SELF_HOSTED_LABELS when the Linux jobs do not go to the VM runners", () => {
      expect(outputs({ EVENT_NAME: "push", FAST_LABELS: vm })).toEqual({ linux: ["self-hosted", "self-hosted-ovis"], fast: ["self-hosted", "self-hosted-ovis"] });
    });

    it("of a fork pull request stay hosted whatever CI_FAST_SELF_HOSTED_LABELS says", () => {
      expect(outputs({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: vm, FAST_LABELS: pc }))
        .toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
    });

    it("follow the Linux jobs when CI_FAST_SELF_HOSTED_LABELS is not a label list with self-hosted", () => {
      for (const bad of ['"ubuntu-24.04"', '["self-hosted-ovis"]', "[]", "not json"]) {
        expect(outputs({ EVENT_NAME: "push", CONFIGURED_LABELS: vm, FAST_LABELS: bad }).fast).toEqual(["self-hosted", "ovis-vm"]);
      }
    });
  });

  it("keeps a fork pull request hosted without the variable", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork" })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request" })).toBe("ubuntu-24.04");
  });

  it("routes a same-repository pull request to the configured labels", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps a fork pull request on the GitHub-hosted image", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels })).toBe("ubuntu-24.04");
  });

  it("lets the dispatch input override the variable", () => {
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: '["self-hosted","other"]', CONFIGURED_LABELS: labels }))
      .toEqual(["self-hosted", "other"]);
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps a fork pull request hosted even with requested labels", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", REQUESTED_LABELS: labels, CONFIGURED_LABELS: labels }))
      .toBe("ubuntu-24.04");
  });

  it("routes a push to main to the configured labels", () => {
    expect(routed({ EVENT_NAME: "push", CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("routes a push to main to CI_MAIN_SELF_HOSTED_LABELS over CI_SELF_HOSTED_LABELS", () => {
    const main = '["self-hosted","self-hosted-ovis-main"]';
    const push = { EVENT_NAME: "push", REF: "refs/heads/main" };
    expect(routed({ ...push, MAIN_LABELS: main })).toEqual(["self-hosted", "self-hosted-ovis-main"]);
    expect(routed({ ...push, MAIN_LABELS: main, CONFIGURED_LABELS: labels })).toEqual(["self-hosted", "self-hosted-ovis-main"]);
    expect(routed({ ...push, MAIN_LABELS: '"ubuntu-24.04"' })).toBe("ubuntu-24.04");
    expect(routed({ ...push, MAIN_LABELS: '"ubuntu-24.04"', CONFIGURED_LABELS: labels })).toBe("ubuntu-24.04");
    // unset or blank: main shares the pull requests' runners, as before
    expect(routed(push)).toEqual(["self-hosted", "self-hosted-ovis"]);
    expect(routed({ ...push, MAIN_LABELS: " " })).toEqual(["self-hosted", "self-hosted-ovis"]);
    expect(routed({ ...push, MAIN_LABELS: " ", CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps every run but a push to main off main's runners", () => {
    const main = '["self-hosted","self-hosted-ovis-main"]';
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, REF: "refs/pull/1/merge", MAIN_LABELS: main })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, MAIN_LABELS: main, CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", MAIN_LABELS: main })).toBe("ubuntu-24.04");
    for (const ref of ["refs/heads/other", "refs/tags/v1.0.0", ""]) {
      expect(routed({ EVENT_NAME: "push", REF: ref, MAIN_LABELS: main })).toEqual(["self-hosted", "self-hosted-ovis"]);
    }
    expect(routed({ EVENT_NAME: "workflow_dispatch", REF: "refs/heads/main", MAIN_LABELS: main })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "workflow_dispatch", REF: "refs/heads/main", MAIN_LABELS: main, REQUESTED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps main hosted too when CI_SELF_HOSTED_LABELS names the GitHub-hosted image", () => {
    expect(routed({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]', CONFIGURED_LABELS: '"ubuntu-24.04"' }))
      .toBe("ubuntu-24.04");
  });

  it("refuses a CI_MAIN_SELF_HOSTED_LABELS that is not self-hosted labels or the hosted image", () => {
    for (const value of ['["self-hosted",', '["self-hosted-ovis-main"]', '"self-hosted"', "[]", '["self-hosted"] ["self-hosted"]']) {
      const result = route({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: value });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("::error::repository variable CI_MAIN_SELF_HOSTED_LABELS");
    }
  });

  it("prints a valid value of the older label variables compacted, one line each", () => {
    const spaced = '[ "self-hosted" ,  "x" ]\n';
    expect(route({ EVENT_NAME: "push", CONFIGURED_LABELS: spaced }).stdout).toBe('linux=["self-hosted","x"]\nfast=["self-hosted","x"]\n');
    expect(route({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: spaced }).stdout).toBe('linux=["self-hosted","x"]\nfast=["self-hosted","x"]\n');
    expect(route({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: spaced }).stdout).toBe('linux=["self-hosted","x"]\nfast=["self-hosted","x"]\n');
    expect(route({ EVENT_NAME: "push", CONFIGURED_LABELS: '["self-hosted","ovis-vm"]', FAST_LABELS: spaced }).stdout).toBe('linux=["self-hosted","ovis-vm"]\nfast=["self-hosted","x"]\n');
  });

  it("refuses malformed JSON", () => {
    const result = route({ EVENT_NAME: "push", CONFIGURED_LABELS: '["self-hosted",' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("::error::");
  });

  it("refuses labels without self-hosted", () => {
    for (const value of ['["linux","x64"]', '"self-hosted"', '[]', '["self-hosted", 1]']) {
      const result = route({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: value });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("::error::");
    }
  });

  describe("hosted_only (pages.yml's call of ci.yml)", () => {
    const vm = '["self-hosted","ovis-vm"]';
    const partsOnHost = {
      EVENT_NAME: "push",
      REF: "refs/heads/main",
      PARTS_LABELS: '["self-hosted","self-hosted-ovis-parts"]',
      PARTS_SEEN: '2000000000 ["self-hosted","self-hosted-ovis-parts"] ["self-hosted-ovis-parts"]',
      FAKE_NOW: "2000000000",
    };
    // every routing above: the input unset or false changes none of them, and true sends each to the hosted image
    const scenarios = (): Record<string, string>[] => [
      { EVENT_NAME: "push" },
      { EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]' },
      { EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: vm, FAST_LABELS: '["self-hosted","self-hosted-ovis"]' },
      { EVENT_NAME: "push", CONFIGURED_LABELS: '"ubuntu-24.04"' },
      { EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({}) },
      { EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({ in_progress: { 1: running(7) } }) },
      { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels },
      { EVENT_NAME: "workflow_dispatch" },
      { EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels },
      { EVENT_NAME: "workflow_dispatch", CONFIGURED_LABELS: labels },
      // main's browser parts on their host, fresh and free (below)
      { ...partsOnHost, FAKE_GH: actions({}) },
    ];

    it("changes nothing when it is unset or false", () => {
      for (const env of scenarios()) {
        const before = route(env);
        for (const value of ["", "false"]) {
          const after = route({ ...env, HOSTED_ONLY: value });
          expect({ env, value, status: after.status, stdout: after.stdout, stderr: after.stderr }).toEqual({ env, value, status: before.status, stdout: before.stdout, stderr: before.stderr });
        }
      }
    });

    it("sends the Linux jobs and Fast checks to the hosted image when true, before it reads anything else", () => {
      // without the input, the parts scenario does print parts=; with it, outputs() takes exactly the two lines
      expect(route({ ...partsOnHost, FAKE_GH: actions({}) }).stdout).toEndWith('\nparts=["self-hosted","self-hosted-ovis-parts"]\n');
      for (const env of scenarios()) expect(outputs({ ...env, HOSTED_ONLY: "true" })).toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
      // a label list the route would refuse is never read
      expect(outputs({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: '"self-hosted"', HOSTED_ONLY: "true" })).toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
    });
  });

  describe("main's browser parts on a further self-hosted host (CI_MAIN_BROWSER_PARTS_LABELS)", () => {
    const host = '["self-hosted","self-hosted-ovis-parts"]';
    const onHost = ["self-hosted", "self-hosted-ovis-parts"];
    const now = 2_000_000_000;
    /** The heartbeat runner-heartbeat.sh writes: when, the labels the runners it counted carry, and those no other runner carries. */
    const beat = (at: number, carried = ["linux", "self-hosted", "self-hosted-ovis-parts", "x64"], alone = ["self-hosted-ovis-parts"]): string =>
      `${at} ${JSON.stringify(carried)} ${JSON.stringify(alone)}`;
    const main = { EVENT_NAME: "push", REF: "refs/heads/main", FAKE_NOW: String(now) };
    const set = { PARTS_LABELS: host, PARTS_SEEN: beat(now - 30) };
    const calls = (dir: string): string => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");

    /**
     * The route for `env` with `variables` added, against the same run without them (each with its own copy of the API
     * state `state`): stdout must be that run's with at most a `parts=` line after it. parts is that line's labels, or
     * null without one.
     */
    function withParts(env: Record<string, string>, variables: Record<string, string> = set, state: () => string = () => actions({})) {
      const [todayState, partsState] = [state(), state()];
      const today = route({ ...env, FAKE_GH: todayState });
      const result = route({ ...env, ...variables, FAKE_GH: partsState });
      expect(result.status).toBe(today.status);
      expect(result.stdout).toStartWith(today.stdout);
      const added = result.stdout.slice(today.stdout.length);
      expect(added).toMatch(/^(parts=[^\n]+\n)?$/);
      return { parts: added === "" ? null : JSON.parse(added.slice("parts=".length)) as unknown, today, result, calls: [calls(todayState), calls(partsState)] };
    }

    it("sends parts 1 and 2 of ci.yml's own push run of main to the host while it is fresh and free", () => {
      expect(route({ ...main, ...set, FAKE_GH: actions({}) }).stdout)
        .toBe('linux=["self-hosted","self-hosted-ovis"]\nfast=["self-hosted","self-hosted-ovis"]\nparts=["self-hosted","self-hosted-ovis-parts"]\n');
      // main's own runners and the other variables keep their lines
      expect(withParts({ ...main, MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]' }).parts).toEqual(onHost);
      expect(withParts({ ...main, CONFIGURED_LABELS: labels }).parts).toEqual(onHost);
    });

    it("changes nothing while the variable is unset, empty or blank, and reads nothing more", () => {
      const vm = '["self-hosted","ovis-vm"]';
      const today: [Record<string, string>, () => string][] = [
        [main, () => actions({})],
        [{ ...main, MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]' }, () => actions({})],
        [{ ...main, EVENT_NAME: "push", REF: "refs/heads/topic" }, () => actions({})],
        [{ ...main, EVENT_NAME: "pull_request", HEAD_REPO: repo }, () => actions({})],
        [{ ...main, EVENT_NAME: "pull_request", HEAD_REPO: repo }, () => actions({ in_progress: { 1: running(5) } })],
        [{ ...main, EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" }, () => actions({})],
        [{ ...main, EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork" }, () => actions({})],
        [{ ...main, EVENT_NAME: "workflow_dispatch" }, () => actions({})],
        [{ ...main, EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels }, () => actions({})],
        [{ ...main, CONFIGURED_LABELS: '"ubuntu-24.04"' }, () => actions({})],
        [{ ...main, LINUX_LABELS: vm }, () => actions({})],
      ];
      for (const [env, state] of today) {
        for (const value of ["", " ", "\n"]) {
          const { parts, today: before, result, calls: [beforeCalls, afterCalls] } = withParts(env, { PARTS_LABELS: value, PARTS_SEEN: beat(now) }, state);
          expect(parts).toBeNull();
          expect(result.stderr).toBe(before.stderr);
          expect(afterCalls).toBe(beforeCalls!);
        }
        const unset = withParts(env, { PARTS_SEEN: beat(now) }, state);
        expect([unset.parts, unset.result.stderr, unset.calls[1]]).toEqual([null, unset.today.stderr, unset.calls[0]]);
      }
    });

    it("leaves every run but a push to main as it is, whatever the variables say", () => {
      for (const env of [
        { ...main, EVENT_NAME: "pull_request", HEAD_REPO: repo, REF: "refs/pull/1/merge" },
        { ...main, EVENT_NAME: "pull_request", HEAD_REPO: repo },
        { ...main, EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" },
        { ...main, EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork" },
        { ...main, REF: "refs/heads/topic" },
        { ...main, REF: "refs/tags/v1.0.0" },
        { ...main, REF: "" },
        { ...main, EVENT_NAME: "workflow_dispatch" },
        { ...main, EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels },
        { ...main, EVENT_NAME: "workflow_run" },
      ]) {
        const { parts, today, result, calls } = withParts(env);
        expect(parts).toBeNull();
        expect(result.stderr).toBe(today.stderr);
        expect(calls[1]).toBe(calls[0]!);
      }
    });

    it("leaves main's parts with the Linux jobs when those are not three self-hosted parts", () => {
      for (const env of [
        { ...main, MAIN_LABELS: '"ubuntu-24.04"' },
        { ...main, CONFIGURED_LABELS: '"ubuntu-24.04"' },
        { ...main, LINUX_LABELS: '["self-hosted","ovis-vm"]' },
        { ...main, MAIN_LABELS: '["self-hosted","OVIS-VM"]' },
      ]) {
        const { parts, calls } = withParts(env);
        expect(parts).toBeNull();
        expect(calls[1]).toBe("");
      }
    });

    it("sends the parts only while the heartbeat is at most 180 s old, or less than a minute ahead", () => {
      for (const at of [now, now - 180, now + 60]) expect(withParts(main, { ...set, PARTS_SEEN: beat(at) }).parts).toEqual(onHost);
      for (const seen of [beat(now - 181), beat(now + 61), beat(now + 3600)]) {
        const { parts, result, calls } = withParts(main, { ...set, PARTS_SEEN: seen });
        expect(parts).toBeNull();
        expect(result.stderr).not.toContain("::warning::");
        // a stale host costs no API call
        expect(calls[1]).toBe("");
      }
      expect(withParts(main, { PARTS_LABELS: host }).parts).toBeNull();
    });

    it("sends the parts only to labels every runner the heartbeat counted carries", () => {
      // a heartbeat in an older form (the time alone, or without the host's own labels) or not two label lists
      for (const seen of [String(now - 30), `${now - 30} ["linux","self-hosted","self-hosted-ovis-parts","x64"]`, "", "soon", `${now} ["self-hosted"`, `${now} ["self-hosted"] ["x64"]`, `${now} "self-hosted"`, `${now} [1]`, "-5 []", "1e9 []"]) {
        const { parts, result, calls } = withParts(main, { ...set, PARTS_SEEN: seen });
        expect(parts).toBeNull();
        expect(result.stderr).not.toContain("::warning::");
        expect(calls[1]).toBe("");
      }
      // a label no counted runner carries would leave the parts queued while the heartbeat stays fresh
      const typo = withParts(main, { ...set, PARTS_LABELS: '["self-hosted","self-hosted-ovis-parts","typo"]' });
      expect(typo.parts).toBeNull();
      expect(typo.result.stderr).toContain('["typo"]');
      expect(typo.result.stderr).not.toContain("::warning::");
      expect(typo.calls[1]).toBe("");
      expect(withParts(main, { ...set, PARTS_SEEN: beat(now, ["self-hosted"]) }).parts).toBeNull();
      // labels compare without case, as GitHub matches them
      expect(withParts(main, { ...set, PARTS_LABELS: '["self-hosted","Self-Hosted-Ovis-Parts"]', PARTS_SEEN: beat(now, ["SELF-HOSTED", "self-hosted-ovis-parts"]) }).parts)
        .toEqual(["self-hosted", "Self-Hosted-Ovis-Parts"]);
    });

    it("sends the parts only to a list that names a label the host's runners alone carry", () => {
      // labels other runners carry too (the PC's, the Mac) could hand a part to one of them
      for (const labels of ['["self-hosted"]', '["self-hosted","linux","x64"]', '["self-hosted","LINUX","X64"]']) {
        const { parts, result, calls } = withParts(main, { ...set, PARTS_LABELS: labels });
        expect(parts).toBeNull();
        expect(result.stderr).not.toContain("::warning::");
        expect(calls[1]).toBe("");
      }
      // the host's own label, with self-hosted (which every label list here names) and with the rest of its labels
      expect(withParts(main, { ...set, PARTS_LABELS: '["self-hosted","self-hosted-ovis-parts"]' }).parts).toEqual(onHost);
      expect(withParts(main, { ...set, PARTS_LABELS: '["self-hosted","linux","x64","Self-Hosted-Ovis-Parts"]' }).parts)
        .toEqual(["self-hosted", "linux", "x64", "Self-Hosted-Ovis-Parts"]);
      // a heartbeat whose host has no label of its own, or names one it does not carry, is no heartbeat
      for (const alone of [[], ["gpu"]]) expect(withParts(main, { ...set, PARTS_SEEN: beat(now - 30, undefined, alone) }).parts).toBeNull();
    });

    it("keeps the parts with the Linux jobs while a job the host's runners could take is queued or running", () => {
      for (const state of [
        () => actions({ in_progress: { 1: running(1, onHost) } }),
        () => actions({ in_progress: { 1: waiting(1, onHost) } }),
        () => actions({ queued: { 2: waiting(1, onHost) } }),
        () => actions({ in_progress: { 1: running(1, ["Self-Hosted", "Self-Hosted-Ovis-Parts"]) } }),
        // a job that asks for fewer labels can take the host's runners too
        () => actions({ in_progress: { 1: running(1, ["self-hosted"]) } }),
        () => actions({ queued: { 2: waiting(1, ["self-hosted", "linux", "x64", "self-hosted-ovis-parts"]) } }),
        // a light job holds a runner as any job does: the pull requests' count leaves it out, this one does not
        () => actions({ in_progress: { 1: [{ status: "in_progress", labels: onHost, name: "Detect changes" }] } }),
        // a job that asks for the runners' own label alone matches them without self-hosted
        () => actions({ queued: { 2: waiting(1, ["self-hosted-ovis-parts"]) } }),
      ]) {
        const { parts, result } = withParts(main, set, state);
        expect(parts).toBeNull();
        expect(result.stderr).not.toContain("::warning::");
      }
      // a label the runners carry beyond CI_MAIN_BROWSER_PARTS_LABELS: a job asking for it can take them as well
      const gpu = { ...set, PARTS_SEEN: beat(now - 30, ["linux", "self-hosted", "self-hosted-ovis-parts", "x64", "gpu"]) };
      expect(withParts(main, gpu, () => actions({ in_progress: { 1: running(1, ["self-hosted", "gpu"]) } })).parts).toBeNull();
      // the PC's jobs and finished ones are not the host's
      const others = actions({ in_progress: { 1: [...running(9), ...running(3, ["self-hosted", "self-hosted-ovis-main"]), { status: "completed", labels: onHost }] } });
      expect(withParts(main, set, () => others).parts).toEqual(onHost);
    });

    it("warns and keeps the parts with the Linux jobs when the host's jobs cannot be read", () => {
      const failing = withParts(main, set, () => tempDir());
      expect(failing.parts).toBeNull();
      expect(failing.result.stderr).toContain("::warning::");
      // asked three times, as every read is
      expect(failing.calls[1]!.trim().split("\n").filter((call) => call.includes("status=in_progress"))).toHaveLength(3);
      const refused = withParts(main, set, () => {
        const dir = actions({});
        writeFileSync(join(dir, "refuse-in_progress"), "");
        return dir;
      });
      expect(refused.parts).toBeNull();
      expect(refused.result.stderr).toContain("::warning::");
      expect(refused.calls[1]!.trim().split("\n")).toHaveLength(1);
      // one failed read asked again is no failure
      const flaky = withParts(main, set, () => {
        const dir = actions({ in_progress: { 1: running(1) } });
        for (const file of ["in_progress", "jobs-1"]) writeFileSync(join(dir, `fail-${file}`), "");
        return dir;
      });
      expect(flaky.parts).toEqual(onHost);
    });

    it("takes an empty answer for a failed read, not an idle host", () => {
      for (const body of ["", " \n"]) {
        for (const file of ["in_progress", "jobs-1"]) {
          const { parts, result } = withParts(main, set, () => {
            const dir = actions({ in_progress: { 1: running(1) } });
            writeFileSync(join(dir, `${file}.json`), body);
            return dir;
          });
          expect(parts).toBeNull();
          expect(result.stderr).toContain("::warning::");
        }
      }
    });

    it("gives the host's count 30 s of reads, then warns and keeps the parts with the Linux jobs", () => {
      // twenty unfinished runs, none on the host: every one is read while the reads are quick
      const runs = () => actions({ in_progress: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [index + 1, running(1)])) });
      /** The run's elapsed seconds, through the route's test seam: each read takes callSeconds of them. */
      const taking = (callSeconds: number): Record<string, string> => {
        const file = join(tempDir(), "seconds");
        writeFileSync(file, "0");
        return { ...main, ROUTE_TEST_SECONDS_FILE: file, FAKE_CALL_SECONDS: String(callSeconds) };
      };
      expect(withParts(taking(1), set, runs).parts).toEqual(onHost);
      // ten seconds a read: the two run lists and one run's jobs fill the 30 s, far inside the script's 240
      const slow = withParts(taking(10), set, runs);
      expect(slow.parts).toBeNull();
      expect(slow.result.stderr).toContain("::warning::");
      expect(slow.calls[1]!.trim().split("\n")).toHaveLength(3);
    });

it("warns and keeps the parts with the Linux jobs when the labels cannot be compared with the heartbeat's", () => {
      const { parts, result, calls } = withParts({ ...main, FAKE_JQ_FAIL: "have" });
      expect(result.status).toBe(0);
      expect(parts).toBeNull();
      expect(result.stderr).toContain("::warning::");
      expect(calls[1]).toBe("");
    });

    it("warns and reads nothing when no timeout or gtimeout could stop a read that hangs", () => {
      // the tools the route and the fakes use, without timeout or gtimeout
      const tools = tempDir();
      for (const tool of ["bash", "sh", "jq", "tr", "mktemp", "cat", "grep", "rm", "date"]) symlinkSync(Bun.which(tool)!, join(tools, tool));
      expect(Bun.which("timeout", { PATH: tools })).toBeNull();
      const { parts, result, calls } = withParts({ ...main, PATH: `${bin}:${tools}` });
      expect(result.status).toBe(0);
      expect(parts).toBeNull();
      expect(result.stderr).toContain("::warning::");
      expect(calls[1]).toBe("");
    });

    it("reads a clock with leading zeroes in base 10", () => {
      // 002000000000 in base 10 is now; read in base 8 it would be decades back, and 000000000008 no number at all
      expect(withParts({ ...main, FAKE_NOW: "002000000000" }).parts).toEqual(onHost);
      const early = withParts({ ...main, FAKE_NOW: "000000000008" });
      expect(early.result.status).toBe(0);
      expect(early.parts).toBeNull();
      expect(early.result.stderr).not.toMatch(/value too great|syntax error|invalid/);
    });

    it("warns and keeps the parts with the Linux jobs when the clock cannot be read", () => {
      for (const clock of ["fail", "soon", "12a"]) {
        const { parts, result, calls } = withParts({ ...main, FAKE_NOW: clock });
        expect(result.status).toBe(0);
        expect(parts).toBeNull();
        expect(result.stderr).toContain("::warning::");
        expect(calls[1]).toBe("");
      }
    });

    it("warns and never fails main's run when the variable is not one label list with self-hosted", () => {
      for (const value of ['"self-hosted"', '["self-hosted-ovis-parts"]', '["self-hosted",', "[]", '["self-hosted", 1]', '"ubuntu-24.04"', `${host}\n${host}`, `${host} ${host}`]) {
        const { parts, result, calls } = withParts(main, { ...set, PARTS_LABELS: value });
        expect(result.status).toBe(0);
        expect(parts).toBeNull();
        expect(result.stderr).toContain("::warning::repository variable CI_MAIN_BROWSER_PARTS_LABELS");
        expect(calls[1]).toBe("");
      }
    });

    it("never writes the variable's value to the log, where a line of it could be a workflow command", () => {
      const { parts, result } = withParts(main, { ...set, PARTS_LABELS: '["self-hosted"\n::error::from the variable' });
      expect(parts).toBeNull();
      expect(result.stderr).toContain("::warning::");
      expect(result.stderr).not.toContain("from the variable");
    });
  });

  describe("Browser regression (other scripts)'s parts", () => {
    type CiJob = { "runs-on"?: unknown; strategy?: { matrix?: { shard?: string } } };
    const ci = Bun.YAML.parse(readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8")) as { jobs: Record<string, CiJob> };
    const shard = ci.jobs["browser-other"]!.strategy!.matrix!.shard!;
    const branches = [...shard.matchAll(/contains\(needs\.changes\.outputs\.linux, '([^']+)'\) && '(\[[\d,]*\])'/g)].map((match) => ({ label: match[1]!, parts: match[2]! }));
    const otherwise = /\|\| '(\[[\d,]*\])'\) \}\}$/.exec(shard)![1]!;
    /** The parts ci.yml's matrix gives for the `linux=` output the route printed (contains() compares strings, ignoring case). */
    const parts = (env: Record<string, string>): number[] => {
      const linux = route(env).stdout.split("\n")[0]!.slice("linux=".length).toLowerCase();
      return JSON.parse(branches.find(({ label }) => linux.includes(label.toLowerCase()))?.parts ?? otherwise) as number[];
    };

    const runsOn = ci.jobs["browser-other"]!["runs-on"] as string;
    const routedParts = /^\$\{\{ inputs\.hosted_only && 'ubuntu-24\.04' \|\| fromJSON\(matrix\.shard <= (\d+) && needs\.changes\.outputs\.parts \|\| needs\.changes\.outputs\.linux\) \}\}$/.exec(runsOn);
    /** Each part's runner, as ci.yml's `runs-on` picks it from the route's outputs (an unset `parts` output is empty, which is false). */
    const runners = (env: Record<string, string>): unknown[] => {
      const printed = Object.fromEntries(route(env).stdout.trimEnd().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
      return parts(env).map((shard) => JSON.parse((shard <= Number(routedParts![1]) && printed["parts"]) || printed["linux"]!) as unknown);
    };
    const now = 2_000_000_000;
    const carried = ' ["linux","self-hosted","self-hosted-ovis-parts","x64"] ["self-hosted-ovis-parts"]';
    const everything = { PARTS_LABELS: '["self-hosted","self-hosted-ovis-parts"]', PARTS_SEEN: `${now}${carried}`, FAKE_NOW: String(now) };

    it("take the route's parts labels for parts 1 and 2 only, and the Linux jobs' runner otherwise", () => {
      expect(routedParts?.[1]).toBe("2");
      const ovisParts = ["self-hosted", "self-hosted-ovis-parts"];
      expect(runners({ EVENT_NAME: "push", REF: "refs/heads/main", ...everything, FAKE_GH: actions({}) })).toEqual([ovisParts, ovisParts, ovis]);
      expect(runners({ EVENT_NAME: "push", REF: "refs/heads/main", ...everything, PARTS_SEEN: `${now - 600}${carried}`, FAKE_GH: actions({}) })).toEqual([ovis, ovis, ovis]);
      expect(runners({ EVENT_NAME: "push", REF: "refs/heads/main", FAKE_GH: actions({}) })).toEqual([ovis, ovis, ovis]);
      expect(runners({ EVENT_NAME: "pull_request", HEAD_REPO: repo, ...everything, FAKE_GH: actions({}) })).toEqual([ovis, ovis, ovis]);
    });

    it("keep every part of a fork pull request hosted, whatever the variables say", () => {
      const vm = '["self-hosted","ovis-vm"]';
      for (const env of [
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", ...everything },
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", REF: "refs/heads/main", ...everything, MAIN_LABELS: labels, CONFIGURED_LABELS: labels, REQUESTED_LABELS: labels, LINUX_LABELS: vm, FAST_LABELS: vm },
        { EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork", REF: "refs/heads/main", ...everything, CONFIGURED_LABELS: labels },
      ]) {
        expect(runners({ ...env, FAKE_GH: actions({}) })).toEqual(["ubuntu-24.04", "ubuntu-24.04", "ubuntu-24.04", "ubuntu-24.04"]);
      }
    });

    it("reads the whole matrix expression", () => {
      expect(`\${{ fromJSON(${branches.map(({ label, parts }) => `contains(needs.changes.outputs.linux, '${label}') && '${parts}' || `).join("")}'${otherwise}') }}`).toBe(shard);
    });

    it("are the four hosted shards for a fork pull request, whatever the variables say", () => {
      const vm = '["self-hosted","ovis-vm"]';
      for (const env of [
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" },
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels, REQUESTED_LABELS: labels, LINUX_LABELS: vm, FAST_LABELS: vm },
        { EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels },
      ]) {
        expect(parts(env)).toEqual([1, 2, 3, 4]);
      }
    });

    it("are three on the self-hosted PC, four hosted and five on the VM runners", () => {
      expect(parts({ EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({}) })).toEqual([1, 2, 3]);
      expect(parts({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]' })).toEqual([1, 2, 3]);
      expect(parts({ EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({ in_progress: { 1: running(5) } }) })).toEqual([1, 2, 3, 4]);
      expect(parts({ EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: '["self-hosted","ovis-vm"]' })).toEqual([1, 2, 3, 4, 5]);
      expect(parts({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]', HOSTED_ONLY: "true" })).toEqual([1, 2, 3, 4]);
    });

    it("count in the route's room for one run: every routed Linux job, the matrix job as its self-hosted parts", () => {
      // browser-other's parts 1 and 2 leave the PC only on main's push runs, never on a pull request's this room is for
      const routedJobs = Object.entries(ci.jobs).filter(([, job]) => ["needs.changes.outputs.linux", "needs.changes.outputs.fast", "matrix.shard <= 2 && needs.changes.outputs.parts || needs.changes.outputs.linux"]
        .some((output) => job["runs-on"] === `\${{ inputs.hosted_only && 'ubuntu-24.04' || fromJSON(${output}) }}`));
      const selfHosted = parts({ EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({}) }).length;
      const needed = routedJobs.reduce((sum, [id]) => sum + (id === "browser-other" ? selfHosted : 1), 0);
      expect(routedJobs.map(([id]) => id).sort()).toEqual(["browser-main", "browser-other", "fast", "integration"]);
      expect(Number(/^linux_jobs=(\d+)$/m.exec(readFileSync(script, "utf8"))![1])).toBe(needed);
    });
  });
});
