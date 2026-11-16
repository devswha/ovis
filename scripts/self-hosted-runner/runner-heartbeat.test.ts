import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./runner-heartbeat.sh", import.meta.url));

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-heartbeat-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// A fake `gh` that logs each call, answers the runner list from $FAKE_GH/runners.json (failing like an API error
// without it) and accepts `variable set`.
const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
case "$1 $2" in
  "api --paginate") [ -f "$FAKE_GH/runners.json" ] || { echo "gh: Server Error (HTTP 502)" >&2; exit 1; }; cat "$FAKE_GH/runners.json" ;;
  "variable set") ;;
  *) exit 1 ;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);

type Runner = { name: string; status: "online" | "offline"; labels: string[] };
const host = (n: number, status: Runner["status"] = "online", labels = ["self-hosted", "Linux", "X64", "self-hosted-ovis-parts"]): Runner =>
  ({ name: `herdr-ci-ovis-parts-${n}`, status, labels });

/** Runs the heartbeat against `pages` of the runner list (none: the list fails) and returns what it set. */
function beat(pages: Runner[][] | null, args: string[] = ["herdr-ci-ovis-parts-", "self-hosted-ovis-parts", "CI_BROWSER_PARTS_RUNNERS_SEEN"]) {
  const state = tempDir();
  if (pages) {
    writeFileSync(join(state, "runners.json"), pages.map((runners) => JSON.stringify({
      total_count: runners.length,
      runners: runners.map(({ labels, ...runner }) => ({ ...runner, busy: false, labels: labels.map((name) => ({ name, type: "custom" })) })),
    })).join("\n"));
  }
  const before = Math.floor(Date.now() / 1000);
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_GH: state, REPO: "devswha/ovis" },
  });
  const after = Math.floor(Date.now() / 1000);
  expect(result.error).toBeUndefined();
  const calls = existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8").trim().split("\n") : [];
  const set = calls.filter((call) => call.startsWith("variable set"));
  return { result, calls, set, before, after };
}

describe.skipIf(process.platform === "win32")("runner-heartbeat.sh", () => {
  /** The time, the labels and the host's own labels a `variable set` call wrote. */
  const written = (call: string): { at: number; labels: unknown; alone: unknown } => {
    const match = /^variable set CI_BROWSER_PARTS_RUNNERS_SEEN --repo devswha\/ovis --body (\d+) (\S+) (\S+)$/.exec(call);
    expect(match).not.toBeNull();
    return { at: Number(match![1]), labels: JSON.parse(match![2]!) as unknown, alone: JSON.parse(match![3]!) as unknown };
  };

  it("writes the time and the runners' labels while enough of the host's runners are online", () => {
    const { result, calls, set, before, after } = beat([[host(1), host(2)]]);
    expect(result.status).toBe(0);
    expect(calls[0]).toBe("api --paginate repos/devswha/ovis/actions/runners?per_page=100");
    expect(set).toHaveLength(1);
    const { at, labels } = written(set[0]!);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(labels).toEqual(["linux", "self-hosted", "self-hosted-ovis-parts", "x64"]);
  });

  it("publishes the labels no other runner of the repository carries", () => {
    const pc = (n: number, status: Runner["status"] = "online"): Runner => ({ name: `herdr-ci-${n}`, status, labels: ["self-hosted", "Linux", "X64", "self-hosted-ovis"] });
    expect(written(beat([[host(1), host(2)]]).set[0]!).alone).toEqual(["linux", "self-hosted", "self-hosted-ovis-parts", "x64"]);
    expect(written(beat([[host(1), pc(1), host(2), pc(2, "offline")]]).set[0]!).alone).toEqual(["self-hosted-ovis-parts"]);
  });

  it("writes nothing while another runner carries every label of the host's, even offline", () => {
    for (const other of [
      { ...host(9), name: "spare-box" },
      { ...host(9, "offline"), name: "spare-box" },
      // the host's own name and label on a runner it does not count (offline) is another runner as well
      host(3, "offline"),
    ]) {
      const { result, set } = beat([[host(1), host(2), other, { name: "herdr-ci-1", status: "online", labels: ["self-hosted", "Linux", "X64", "self-hosted-ovis"] }]]);
      expect(result.status).toBe(0);
      expect(set).toEqual([]);
    }
  });

  it("writes nothing while the runners it counts carry different labels", () => {
    // a job asking for gpu could take runner 2 alone, which a label list for the host would not show
    const gpu = host(2, "online", ["self-hosted", "Linux", "X64", "self-hosted-ovis-parts", "gpu"]);
    const { result, set } = beat([[host(1), gpu]]);
    expect(result.status).toBe(0);
    expect(set).toEqual([]);
    // the same labels in another order or case are the same set
    const same = host(3, "online", ["SELF-HOSTED", "self-hosted-ovis-parts", "x64", "linux"]);
    expect(written(beat([[host(1), same]]).set[0]!).labels).toEqual(["linux", "self-hosted", "self-hosted-ovis-parts", "x64"]);
  });

  it("counts the runners on every page, with the label in any case", () => {
    expect(beat([[host(1)], [host(2, "online", ["SELF-HOSTED", "LINUX", "X64", "SELF-HOSTED-OVIS-PARTS"])]]).set).toHaveLength(1);
  });

  it("writes nothing while fewer runners than asked for are online", () => {
    for (const runners of [
      [],
      [host(1)],
      [host(1), host(2, "offline")],
      // the PC's runners and the host's name without its label are not the host's runners
      [host(1), { ...host(2), name: "herdr-ci-1" }],
      [host(1), host(2, "online", ["self-hosted", "self-hosted-ovis"])],
    ]) {
      const { result, set } = beat([runners]);
      expect(result.status).toBe(0);
      expect(set).toEqual([]);
    }
  });

  it("takes the number of runners it needs from its fourth argument", () => {
    const args = ["herdr-ci-ovis-parts-", "self-hosted-ovis-parts", "CI_BROWSER_PARTS_RUNNERS_SEEN"];
    expect(beat([[host(1)]], [...args, "1"]).set).toHaveLength(1);
    expect(beat([[host(1), host(2)]], [...args, "3"]).set).toEqual([]);
    for (const bad of ["0", "two", "-1"]) {
      const { result, calls } = beat([[host(1), host(2)]], [...args, bad]);
      expect(result.status).toBe(2);
      expect(calls).toEqual([]);
    }
  });

  it("writes nothing and fails when the runner list cannot be read", () => {
    const { result, set } = beat(null);
    expect(result.status).toBe(1);
    expect(set).toEqual([]);
  });
});
