import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./remote-runners.sh", import.meta.url));
// a slow host's bound: every wait below ends on an event, this only caps a test that went wrong
const BOUND_MS = 15_000;

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "remote-runners-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// The fakes: never the real gh or ssh. Each logs its calls in $FAKE, and says what happened by writing a byte to a FIFO
// of $FAKE the test made (got, beat, holding), which the test reads: no polling.
// gh: generate-jitconfig answers runner id 100, 101, ... with the configuration "Y29uZmln<id>AA==" (fails with
// $FAKE_GENERATE=fail); DELETE is only logged; `variable set` says "beat" the first time; the runner list is
// $FAKE/runners.json.
// ssh: one line of its arguments per call. Its slot is the last word of its remote command. In $FAKE_SSH_MODE:
//   job: prints a line, records whether a configuration of its slot was made before it says READY, says READY, keeps
//        the line it reads on stdin (empty at EOF, then fails) and says "got" for the first three, prints the job's
//        output and ends;
//   hold: as job, but then says "holding" and stays until its stdin ends (recorded) or it gets TERM (recorded);
//   no-ready: prints a line and fails; silent: says nothing and stays until TERM (recorded).
const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE/gh-calls"
case "$*" in
  "api -X POST "*generate-jitconfig*)
    [ "\${FAKE_GENERATE:-}" = fail ] && { echo "gh: Already exists (HTTP 409)" >&2; exit 1; }
    # slots ask at the same moment: one id each
    exec 9> "$FAKE/next-id.lock"; flock 9
    n=$(cat "$FAKE/next-id" 2>/dev/null || echo 100); echo $((n + 1)) > "$FAKE/next-id"
    exec 9>&-
    printf '{"runner":{"id":%s,"name":"x"},"encoded_jit_config":"Y29uZmln%sAA=="}\\n' "$n" "$n" ;;
  "api -X DELETE "*) ;;
  "api --paginate "*/actions/runners*) cat "$FAKE/runners.json" 2>/dev/null || echo '{"total_count":0,"runners":[]}' ;;
  "variable set "*) if [ -p "$FAKE/beat" ] && [ ! -e "$FAKE/beat-said" ]; then : > "$FAKE/beat-said"; printf x > "$FAKE/beat"; fi ;;
  *) exit 1 ;;
esac
`);
writeFileSync(join(bin, "ssh"), `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE/ssh-calls"
for remote; do :; done
slot=\${remote##* }
case "\${FAKE_SSH_MODE:-job}" in
  no-ready) echo "setting up"; exit 1 ;;
  silent) trap 'echo term >> "$FAKE/term-$slot"; exit 143' TERM; while :; do sleep 1 & wait $!; done ;;
esac
echo "setting up slot $slot"
made=$(grep -c -- "name=herdr-ci-ovis-parts-$slot " "$FAKE/gh-calls" 2>/dev/null); echo "\${made:-0}" > "$FAKE/made-before-ready-$slot"
echo READY
IFS= read -r config || true
printf '%s\\n' "$config" >> "$FAKE/config-$slot"
[ -n "$config" ] || exit 1
if [ -p "$FAKE/got" ] && [ "$(wc -l < "$FAKE/config-$slot")" -le 3 ]; then printf x > "$FAKE/got"; fi
echo "job ran"
if [ "\${FAKE_SSH_MODE:-job}" = hold ]; then
  # a background command reads /dev/null unless told otherwise
  cat > /dev/null <&0 & reader=$!
  trap 'echo term >> "$FAKE/term-$slot"; kill $reader 2>/dev/null; exit 143' TERM
  printf x > "$FAKE/holding"
  wait $reader
  echo stdin-ended >> "$FAKE/term-$slot"
fi
exit 0
`);
chmodSync(join(bin, "gh"), 0o755);
chmodSync(join(bin, "ssh"), 0o755);

const REMOTE = ["/srv/ovis-ci/launcher/run.sh", "--repo", "devswha/ovis", "--cpuset-cpus", "0-11"];
const ARGS = ["--host", "hosthatch", "--repo", "devswha/ovis", "--name-prefix", "herdr-ci-ovis-parts-", "--labels", "self-hosted-ovis-parts"];

function launcherEnv(fake: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE: fake, ...extra };
}
const read = (fake: string, file: string): string => (existsSync(join(fake, file)) ? readFileSync(join(fake, file), "utf8") : "");
const lines = (fake: string, file: string): string[] => read(fake, file).split("\n").filter((line) => line !== "");

function launch(args: string[], extra: Record<string, string> = {}) {
  const fake = tempDir();
  const result = spawnSync("bash", [script, ...args], { encoding: "utf8", timeout: BOUND_MS, env: launcherEnv(fake, extra) });
  expect(result.error).toBeUndefined();
  return { result, fake, gh: lines(fake, "gh-calls"), ssh: lines(fake, "ssh-calls") };
}

/** Makes the FIFOs `names` in `fake`, for the fakes to say what happened. */
function fifos(fake: string, ...names: string[]): void {
  for (const name of names) expect(spawnSync("mkfifo", [join(fake, name)]).status).toBe(0);
}
/** Resolves once a fake has said `name` (one byte on its FIFO); fails past BOUND_MS. */
async function heard(fake: string, name: string): Promise<void> {
  const reader = Bun.spawn(["head", "-c", "1", join(fake, name)], { stdout: "ignore", stderr: "ignore" });
  const ended = await Promise.race([reader.exited, Bun.sleep(BOUND_MS).then(() => "never" as const)]);
  if (ended === "never") {
    reader.kill("SIGKILL");
    throw new Error(`never happened: ${name}`);
  }
}

describe.skipIf(process.platform === "win32")("remote-runners.sh", () => {
  it("makes one configuration per start, only after the host says READY, and hands it over on stdin alone", () => {
    const { result, fake, gh, ssh } = launch([...ARGS, "--count", "2", "--once", "--", ...REMOTE]);
    expect(result.status).toBe(0);
    const made = gh.filter((call) => call.includes("generate-jitconfig"));
    expect(made).toHaveLength(2);
    for (const slot of [1, 2]) {
      const call = made.find((line) => line.includes(`name=herdr-ci-ovis-parts-${slot} `))!;
      expect(call).toBe(`api -X POST repos/devswha/ovis/actions/runners/generate-jitconfig -f name=herdr-ci-ovis-parts-${slot} -F runner_group_id=1 -f labels[]=self-hosted -f labels[]=self-hosted-ovis-parts -f work_folder=/w`);
      // nothing was made for this slot before its host was ready
      expect(read(fake, `made-before-ready-${slot}`).trim()).toBe("0");
      expect(ssh).toContain(`-o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=10 hosthatch ${REMOTE.join(" ")} --jit-slot ${slot}`);
    }
    // each host got the configuration of one runner, on stdin: never on a command line
    const configs = [1, 2].map((slot) => read(fake, `config-${slot}`).trim());
    expect(configs.sort()).toEqual(["Y29uZmln100AA==", "Y29uZmln101AA=="]);
    for (const config of configs) expect(ssh.join("\n")).not.toContain(config);
    expect(result.stderr).not.toContain("Y29uZmln");
    // and each runner GitHub made is deleted by its id once its session ends (a 404 when it ran its job)
    expect(gh.filter((call) => call.startsWith("api -X DELETE")).sort()).toEqual(["api -X DELETE repos/devswha/ovis/actions/runners/100", "api -X DELETE repos/devswha/ovis/actions/runners/101"]);
    expect(result.stderr).toContain("[herdr-ci-ovis-parts-1] job ran");
  });

  it("makes no configuration when the host never says READY", () => {
    const { result, gh, ssh } = launch([...ARGS, "--once", "--", ...REMOTE], { FAKE_SSH_MODE: "no-ready" });
    expect(result.status).toBe(1);
    expect(ssh).toHaveLength(1);
    expect(gh.filter((call) => call.includes("generate-jitconfig") || call.includes("DELETE"))).toEqual([]);
    expect(result.stderr).toContain("did not say READY");
  });

  it("ends a session that stays silent past --ready-wait, by its own pid, and makes nothing", () => {
    const { result, fake, gh } = launch([...ARGS, "--once", "--ready-wait", "1", "--", ...REMOTE], { FAKE_SSH_MODE: "silent" });
    expect(result.status).toBe(1);
    expect(read(fake, "term-1")).toBe("term\n");
    expect(gh).toEqual([]);
  });

  it("closes the host's stdin when GitHub makes no configuration, and deletes only an offline runner of exactly the slot's name", () => {
    const fake = tempDir();
    writeFileSync(join(fake, "runners.json"), JSON.stringify({
      total_count: 4,
      runners: [
        { id: 7, name: "herdr-ci-ovis-parts-1", status: "offline" },
        { id: 8, name: "herdr-ci-ovis-parts-10", status: "offline" },
        { id: 9, name: "herdr-ci-devswha-ThinkStation-P620-1", status: "offline" },
        { id: 10, name: "herdr-ci-ovis-parts-2", status: "offline" },
      ],
    }));
    const result = spawnSync("bash", [script, ...ARGS, "--once", "--", ...REMOTE], { encoding: "utf8", timeout: BOUND_MS, env: launcherEnv(fake, { FAKE_GENERATE: "fail" }) });
    expect(result.status).toBe(1);
    // the host read the end of its stdin, no configuration
    expect(read(fake, "config-1")).toBe("\n");
    expect(lines(fake, "gh-calls").filter((call) => call.startsWith("api -X DELETE"))).toEqual(["api -X DELETE repos/devswha/ovis/actions/runners/7"]);
  });

  it("leaves an online runner of the slot's name alone", () => {
    const fake = tempDir();
    writeFileSync(join(fake, "runners.json"), JSON.stringify({ total_count: 1, runners: [{ id: 7, name: "herdr-ci-ovis-parts-1", status: "online" }] }));
    const result = spawnSync("bash", [script, ...ARGS, "--once", "--", ...REMOTE], { encoding: "utf8", timeout: BOUND_MS, env: launcherEnv(fake, { FAKE_GENERATE: "fail" }) });
    expect(result.status).toBe(1);
    expect(lines(fake, "gh-calls").filter((call) => call.startsWith("api -X DELETE"))).toEqual([]);
  });

  it("starts a slot again after each job, with a configuration of its own each time", async () => {
    const fake = tempDir();
    fifos(fake, "got");
    const child = Bun.spawn(["bash", script, ...ARGS, "--", ...REMOTE], { env: launcherEnv(fake), stdout: "ignore", stderr: "ignore" });
    try {
      for (let start = 0; start < 3; start++) await heard(fake, "got");
      child.kill("SIGTERM");
      expect(await Promise.race([child.exited, Bun.sleep(BOUND_MS).then(() => "still running")])).toBe(143);
      const configs = lines(fake, "config-1");
      expect(configs.slice(0, 3)).toEqual(["Y29uZmln100AA==", "Y29uZmln101AA==", "Y29uZmln102AA=="]);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  it("at a stop ends only the sessions it started, deletes their runners, and keeps the heartbeat beside them", async () => {
    const fake = tempDir();
    writeFileSync(join(fake, "runners.json"), JSON.stringify({
      total_count: 1,
      runners: [{ id: 100, name: "herdr-ci-ovis-parts-1", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "self-hosted-ovis-parts" }] }],
    }));
    fifos(fake, "holding", "beat");
    // an ssh of the same name and arguments that this launcher did not start
    const decoyFake = tempDir();
    const decoy = Bun.spawn([join(bin, "ssh"), "-o", "BatchMode=yes", "hosthatch", ...REMOTE, "--jit-slot", "1"], {
      env: launcherEnv(decoyFake, { FAKE_SSH_MODE: "silent" }), stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const child = Bun.spawn(["bash", script, ...ARGS, "--heartbeat", "CI_BROWSER_PARTS_RUNNERS_SEEN", "--", ...REMOTE], {
      env: launcherEnv(fake, { FAKE_SSH_MODE: "hold" }), stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    try {
      await heard(fake, "holding");
      await heard(fake, "beat");
      expect(lines(fake, "gh-calls").filter((call) => call.startsWith("variable set "))[0]).toMatch(/^variable set CI_BROWSER_PARTS_RUNNERS_SEEN --repo devswha\/ovis --body \d+ \["self-hosted","self-hosted-ovis-parts"\] \["self-hosted","self-hosted-ovis-parts"\]$/);
      child.kill("SIGTERM");
      expect(await Promise.race([child.exited, Bun.sleep(BOUND_MS).then(() => "still running")])).toBe(143);
      // its own session got the stop; the decoy did not
      expect(read(fake, "term-1")).toBe("term\n");
      expect(decoy.exitCode).toBeNull();
      expect(read(decoyFake, "term-1")).toBe("");
      expect(lines(fake, "gh-calls")).toContain("api -X DELETE repos/devswha/ovis/actions/runners/100");
      expect(await stderr).not.toContain("Y29uZmln");
    } finally {
      child.kill("SIGKILL");
      decoy.kill("SIGKILL");
      await Promise.all([child.exited, decoy.exited]);
    }
  });

  it("refuses arguments that would reach an ssh command line or a registration unchecked, before it starts anything", () => {
    for (const args of [
      ["--host", "-oProxyCommand=x", ...ARGS.slice(2), "--", ...REMOTE],
      [...ARGS.slice(0, 7), "self-hosted", "--", ...REMOTE],
      [...ARGS.slice(0, 7), "a b", "--", ...REMOTE],
      [...ARGS.slice(0, 5), "herdr ci", ...ARGS.slice(6), "--", ...REMOTE],
      [...ARGS, "--count", "0", "--", ...REMOTE],
      [...ARGS, "--heartbeat", "A-B", "--", ...REMOTE],
      [...ARGS],
    ]) {
      const { result, gh, ssh } = launch(args);
      expect([args.join(" "), result.status]).toEqual([args.join(" "), 2]);
      expect(gh).toEqual([]);
      expect(ssh).toEqual([]);
    }
  });
});
