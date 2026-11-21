import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/self-hosted-runner/winvm-runner.sh --once against fake winvm, ssh, scp, gh and sleep: what it resets, when it
// offers winvm to the route (CI_WINVM_READY) and what it leaves to the next user of the VM.
const script = fileURLToPath(new URL("./self-hosted-runner/winvm-runner.sh", import.meta.url));
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const fakes: Record<string, string> = {
  winvm: `#!/bin/bash
echo "winvm $*" >> "$FAKE/calls"
case "$1" in
  status) cat "$FAKE/state"; if [ -f "$FAKE/lease" ]; then echo "lease: $(cat "$FAKE/lease")"; else echo "lease: free"; fi ;;
  lease) if [ -f "$FAKE/lease" ] && [ "$(cut -d' ' -f1 "$FAKE/lease")" != "$2" ]; then echo "winvm: busy, leased by $(cat "$FAKE/lease")"; exit 1; fi
         echo "$2 2026-11-21T00:00:00+09:00" > "$FAKE/lease"; echo "winvm: leased to $2" ;;
  release) rm -f "$FAKE/lease" ;;
  reset|start) [ -f "$FAKE/reset-fails" ] && exit 1; [ "$1" = start ] && echo running > "$FAKE/state"; true ;;
esac
`,
  ssh: `#!/bin/bash
cmd="\${@: -1}"
case "$cmd" in
  *"Get-Process Runner.Worker"*) [ -f "$FAKE/unreachable" ] && exit 255; cat "$FAKE/workers" ;;
  *"Get-Process explorer"*) echo UP ;;
  *"ReadLine"*) cat > "$FAKE/token" ;;
  *Invoke-InSession*) echo "ssh $cmd" >> "$FAKE/calls"; echo "rounds" >> "$FAKE/rounds"
    echo "Current runner version: '9.9.9'"; echo "2026-11-21 00:00:00Z: Listening for Jobs"
    echo "2026-11-21 00:00:05Z: Running job: Native Windows install"; echo "Job Native Windows install completed with result: Succeeded" ;;
  *) true ;;
esac
`,
  scp: "#!/bin/sh\nexit 0\n",
  sleep: "#!/bin/sh\nexit 0\n",
  gh: `#!/bin/bash
echo "gh $*" >> "$FAKE/calls"
case "$*" in
  "variable set"*) echo "mark \${@: -1}" >> "$FAKE/marks" ;;
  *releases/latest*) echo v9.9.9 ;;
  *registration-token*) echo SECRET-TOKEN ;;
  *"-X DELETE"*) echo deleted >> "$FAKE/deleted" ;;
  *actions/runners*) echo 42 ;;
  *"runs?status=queued"*) n=$(cat "$FAKE/queued" 2>/dev/null || echo 0); [ "$n" -gt 0 ] && echo 7; true ;;
  *runs/7/jobs*) n=$(cat "$FAKE/queued"); echo "$n"; echo $((n - 1)) > "$FAKE/queued" ;;
  *) true ;;
esac
`,
};

function setup(state: { workers?: string; unreachable?: boolean; resetFails?: boolean; queued?: number; lease?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "winvm-runner-"));
  created.push(dir);
  const bin = join(dir, "bin");
  const fake = join(dir, "fake");
  const cache = join(dir, "cache");
  for (const d of [bin, fake, join(cache, "winvm-runner")]) mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(cache, "winvm-runner", "actions-runner-win-x64-9.9.9.zip"), "zip");
  writeFileSync(join(fake, "state"), "running\n");
  writeFileSync(join(fake, "workers"), `${state.workers ?? "0"}\n`);
  for (const file of ["calls", "marks", "rounds", "deleted"]) writeFileSync(join(fake, file), "");
  if (state.unreachable) writeFileSync(join(fake, "unreachable"), "");
  if (state.resetFails) writeFileSync(join(fake, "reset-fails"), "");
  if (state.queued) writeFileSync(join(fake, "queued"), String(state.queued));
  if (state.lease) writeFileSync(join(fake, "lease"), `${state.lease} 2026-11-21T00:00:00+09:00\n`);
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE: fake, XDG_CACHE_HOME: cache, HOME: dir };
  const lines = (file: string): string[] => readFileSync(join(fake, file), "utf8").split("\n").filter(Boolean);
  const run = () => {
    const result = spawnSync("bash", [script, "--once"], { encoding: "utf8", timeout: 30_000, env });
    expect(result.error).toBeUndefined();
    return result;
  };
  return { run, env, lines, lockFile: join(cache, "winvm-runner", "launcher.lock"), leaseHeld: () => existsSync(join(fake, "lease")) };
}

const vmCalls = (calls: string[]): string[] => calls.filter((call) => /^winvm (reset|start|release)/.test(call));

describe.skipIf(process.platform === "win32")("winvm-runner.sh", () => {
  it("resets winvm before the job and after it, offers it only while its runner listens, and frees it", () => {
    const { run, lines, leaseHeld } = setup();
    const result = run();
    expect(result.status).toBe(0);
    expect(vmCalls(lines("calls"))).toEqual(["winvm reset", "winvm start", "winvm reset", "winvm start", "winvm release"]);
    const marks = lines("marks").map((line) => line.slice("mark ".length));
    expect(marks.some((mark) => /^[1-9]\d{9}$/.test(mark))).toBe(true);
    expect(marks.at(-1)).toBe("0");
    expect(marks.indexOf("0", marks.findIndex((mark) => mark !== "0"))).toBeGreaterThan(0);
    expect(lines("deleted")).toEqual(["deleted"]);
    expect(leaseHeld()).toBe(false);
  });

  it("hands the registration token over stdin, never in a command line", () => {
    const { run, lines, env } = setup();
    expect(run().status).toBe(0);
    expect(readFileSync(join(env.FAKE, "token"), "utf8")).toBe("SECRET-TOKEN\n");
    expect(lines("calls").filter((call) => call.includes("SECRET-TOKEN"))).toEqual([]);
  });

  // each walks the hour of waiting for an answer (sleep is a no-op), then the cleanup's ten minutes
  for (const [why, state] of [["the VM does not answer", { unreachable: true }], ["another runner in it is in a job", { workers: "1" }]] as const) {
    it(`resets nothing while ${why}, keeps the lease and fails`, () => {
      const { run, lines, leaseHeld } = setup(state);
      const result = run();
      expect(result.status).toBe(1);
      expect(vmCalls(lines("calls"))).toEqual([]);
      expect(lines("rounds")).toEqual([]);
      expect(leaseHeld()).toBe(true);
      expect(result.stdout).toContain("winvm was not reset; the lease stays with ci-winvm-runner");
    }, 15_000);
  }

  it("keeps the lease and fails when the reset after the job fails", () => {
    const { run, lines, leaseHeld } = setup({ resetFails: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(lines("calls")).not.toContain("winvm release");
    expect(leaseHeld()).toBe(true);
  });

  it("takes no job and touches nothing while a lane holds the lease", () => {
    const { run, lines } = setup({ lease: "some-lane" });
    const result = run();
    expect(result.status).toBe(0);
    expect(vmCalls(lines("calls"))).toEqual([]);
    expect(lines("rounds")).toEqual([]);
    expect(result.stdout).toContain("winvm: busy, leased by some-lane");
  });

  it("serves a job still queued for its label before it stops", () => {
    const { run, lines } = setup({ queued: 1 });
    expect(run().status).toBe(0);
    expect(lines("rounds")).toHaveLength(2);
  });

  it("refuses to run beside another copy", async () => {
    const { run, lines, lockFile } = setup();
    const holder = spawn("flock", [lockFile, "-c", "echo locked; read"], { stdio: ["pipe", "pipe", "inherit"] });
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    try {
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("another copy runs");
      expect(lines("calls")).toEqual([]);
    } finally {
      holder.stdin.end();
      await new Promise((resolve) => holder.once("exit", resolve));
    }
  });
});
