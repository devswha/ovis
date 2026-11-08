import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type PcInstallFailure, type PcInstallJob } from "../shared/machines.ts";
import { PcInstaller, type InstallConnect } from "./pc-install.ts";
import { SshConnection } from "./ssh.ts";

// A PC reached over SSH, as a script-answering stand-in: every command this app would run there is answered here,
// and none reaches a real PC, the user's herdr or the network. An unexpected command fails the test.
const SOCKET = "/home/fx/.config/herdr/herdr.sock";
interface Descriptor { pid: number; port: number; token: string; socket_path: string; managed_remote: boolean; bridge_protocol: number; bundle_version: string }
const descriptor = (pid: number, managed = false, token = "a".repeat(64)): Descriptor => ({ pid, port: 7317, token, socket_path: SOCKET, managed_remote: managed, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION });
interface Pc {
  /** what ssh says when it cannot get in with keys, or nothing */
  refused?: string;
  os?: string;
  tools?: string[];
  freeKb?: number;
  writable?: boolean;
  herdrRunning?: boolean;
  /** an Ovis installed there, and how it starts itself */
  launcher?: "plugin" | "systemd";
  /** what `ps` names the process of the plan's pid: an Ovis server unless set */
  command?: string;
  /** the new Ovis registers with this pid: one an old descriptor already named, reused */
  newPid?: number;
  /** the installer's answer: its exit status and last words; it starts the plugin when herdr runs */
  installer?: { exit: number; output: string };
  /** the installed Ovis never registers */
  neverStarts?: boolean;
  descriptors?: Descriptor[];
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(pc: Pc) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pc-install-"));
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close };
  cleanups.push(() => { Object.assign(SshConnection.prototype, real); rmSync(dir, { recursive: true, force: true }); });
  const listed: Descriptor[] = [...(pc.descriptors ?? [])];
  const alive = new Set(listed.map((d) => d.pid));
  const commands: string[] = [];
  const challenges: unknown[] = [];
  const register = () => { if (pc.neverStarts) return; const next = descriptor(pc.newPid ?? 5555, false, "b".repeat(64)); listed.push(next); alive.add(next.pid); };
  SshConnection.prototype.start = async (challenge?: unknown) => { challenges.push(challenge); if (pc.refused) throw new Error(pc.refused); };
  SshConnection.prototype.close = () => {};
  SshConnection.prototype.run = async (script: string) => {
    commands.push(script);
    if (script.includes("free_kb=")) {
      const tools = pc.tools ?? ["curl", "git", "tar"];
      return [`os=${pc.os ?? "Linux"}`, "arch=x86_64", ...tools.map((tool) => `has=${tool}`), ...(pc.writable === false ? [] : ["writable=1"]), `free_kb=${pc.freeKb ?? 50_000_000}`,
        "herdr=1", ...(pc.herdrRunning === false ? [] : ["herdr_running=1"]), `launcher=${pc.launcher ?? "none"}`].join("\n") + "\n";
    }
    if (script.includes("uname -s") && script.includes("bundle-ready")) return `Linux\nx86_64\n/home/fx\n/home/fx/.config\n/usr/bin/herdr\n${listed.map((d) => JSON.stringify(d)).join("\n")}\n`;
    if (script.includes("socket=")) return SOCKET;
    if (script.startsWith("ps -o args=")) return pc.command ?? "/home/fx/.bun/bin/bun /home/fx/ovis/server/index.ts";
    if (script.includes("kill -0")) return alive.has(Number(/kill -0 (\d+)/.exec(script)![1])) ? "live" : "";
    if (script.includes("kill -TERM")) { alive.delete(Number(/kill -TERM (\d+)/.exec(script)![1])); return ""; }
    if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) return listed.map((d) => JSON.stringify(d)).join("\n") + "\n";
    if (script.includes("https://ovis.sh/install.sh")) {
      const answer = pc.installer ?? { exit: 0, output: "Ovis: installing the herdr plugin" };
      if (answer.exit === 0 && pc.herdrRunning !== false) register();
      return `${answer.output}\novis-install-exit=${answer.exit}\n`;
    }
    if (script.includes(" server </dev/null")) { register(); return ""; }
    if (script.includes("devswha.ovis.start") || script.includes("ovis.service")) { if (script.includes("devswha.ovis.stop") || script.includes("restart")) for (const d of listed) alive.delete(d.pid); register(); return ""; }
    throw new Error(`Unexpected remote command: ${script}`);
  };
  const connects: Parameters<InstallConnect>[0][] = [];
  let answer: string | null = null;
  /** while set, the connect after the install waits for it */
  let held: Promise<void> | null = null;
  let cancelled = 0;
  const connect: InstallConnect = (request) => { connects.push(request); return { job_id: "setup-job", cancel: () => { cancelled++; }, finished: (held ?? Promise.resolve()).then(() => answer) }; };
  const installer = new PcInstaller({ sshDir: join(dir, "ssh"), connect, release: "v9.9.9", pollMs: 1, startMs: 200 });
  cleanups.push(() => installer.stop());
  const settled = async (job: PcInstallJob) => { await installer.finished(job.id); return installer.job(job.id)!; };
  return { installer, commands, challenges, connects, settled, alive, failConnect: (words: string) => { answer = words; }, holdConnect: (gate: Promise<void>) => { held = gate; }, cancelled: () => cancelled };
}

const target = { destination: "me@lab.invalid" };
const installs = (commands: string[]) => commands.filter((command) => command.includes("install.sh"));

describe("installing Ovis on a PC over SSH", () => {
  it("runs the official installer pinned to this app's release with keys only, waits for it to answer, then connects it", async () => {
    const pc = fixture({});
    const job = await pc.settled(pc.installer.start({ target, name: "Lab" }));
    expect(job).toMatchObject({ phase: "connected", error: null, error_code: null, connect_job: "setup-job", mode: "install", machine_id: null });
    expect(pc.challenges).toEqual([undefined]);
    expect(installs(pc.commands)).toHaveLength(1);
    // downloaded to a file and run from it: piped into a sh whose stdin is /dev/null, nothing would run at all
    expect(installs(pc.commands)[0]).toContain("curl -fsSL --max-time 120 https://ovis.sh/install.sh -o \"$script\"");
    expect(installs(pc.commands)[0]).toContain("OVIS_REF=v9.9.9 OVIS_RUNTIME=herdr OVIS_NO_OPEN=1 sh \"$script\" </dev/null");
    expect(installs(pc.commands)[0]).not.toContain("| OVIS_REF");
    expect(pc.connects).toEqual([{ target, name: "Lab", update: false }]);
  });

  it("starts herdr without a terminal when the installed plugin waits for it", async () => {
    const pc = fixture({ herdrRunning: false });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job.phase).toBe("connected");
    expect(pc.commands.some((command) => command.includes("nohup herdr server </dev/null"))).toBe(true);
  });

  const refusals: [string, Pc, PcInstallFailure, RegExp][] = [
    ["keys are not let in", { refused: "me@lab.invalid: Permission denied (publickey,password)." }, "ssh_refused", /did not let this app in with SSH keys/],
    ["its host key is unknown", { refused: "Host key verification failed." }, "ssh_host_key", /host key is not known here/],
    ["it cannot be reached", { refused: "ssh: Could not resolve hostname lab.invalid: Name or service not known" }, "ssh_unreachable", /could not be reached over SSH: ssh: Could not resolve hostname/],
    ["it runs Windows", { os: "MINGW64_NT-10.0" }, "unsupported", /Linux and macOS/],
    ["it has no curl", { tools: ["git", "tar"] }, "missing_tool", /has no curl/],
    ["its disk is full", { freeKb: 200_000 }, "disk", /only 195 MB free/],
    ["its home is not writable", { writable: false }, "permission", /cannot write to its own home folder/],
    ["this app's bridge serves it", { descriptors: [descriptor(4242, true)] }, "bridge_there", /runs this app's bridge/],
    ["Ovis already runs there", { descriptors: [descriptor(4242)] }, "ovis_there", /Ovis already runs on that PC/],
  ];
  for (const [when, pcState, code, words] of refusals) it(`says in plain words why it cannot install when ${when}, and installs nothing`, async () => {
    const pc = fixture(pcState);
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job.phase).toBe("failed");
    expect(job.error_code).toBe(code);
    expect(job.error).toMatch(words);
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.connects).toEqual([]);
  });

  it("refuses a named herdr session, which the installer does not serve", async () => {
    const pc = fixture({});
    const job = await pc.settled(pc.installer.start({ target: { ...target, session: "work" } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "unsupported" });
    expect(pc.commands).toEqual([]);
  });

  it("tells the installer's own last words when it fails there", async () => {
    const pc = fixture({ installer: { exit: 1, output: "Ovis: needs herdr 0.9.0 or newer; this is 0.8.1." } });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(job.error).toBe("The Ovis installer failed on that PC: Ovis: needs herdr 0.9.0 or newer; this is 0.8.1.");
  });

  it("fails in plain words when the installed Ovis never starts, or the connect after it fails", async () => {
    const silent = fixture({ neverStarts: true });
    expect(await silent.settled(silent.installer.start({ target }))).toMatchObject({ phase: "failed", error_code: "not_started" });
    const refused = fixture({});
    refused.failConnect("This PC needs a password.");
    expect(await refused.settled(refused.installer.start({ target }))).toMatchObject({ phase: "failed", error_code: "connect_failed", error: "This PC needs a password." });
  });

  it("replaces a server started by hand: stops that very process, installs, and connects the PC it was for", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "replace", machine_id: "pc-1" });
    expect(pc.alive.has(4242)).toBe(false);
    expect(pc.commands.findIndex((command) => command.includes("kill -TERM 4242"))).toBeLessThan(pc.commands.findIndex((command) => command.includes("install.sh")));
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: false }]);
  });

  it("restarts a too-old supervisor through its own launcher, stopping it there rather than by its pid, then asks for the update", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], launcher: "plugin" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "restart" });
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
    expect(pc.commands.some((command) => command.includes("herdr plugin action invoke devswha.ovis.stop") && command.includes("devswha.ovis.start"))).toBe(true);
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: true }]);
  });

  it("stops nothing for a restart when no launcher there could start it again", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "no_launcher" });
    expect(pc.alive.has(4242)).toBe(true);
    expect(pc.commands.some((command) => command.includes("kill") && !command.includes("kill -0"))).toBe(false);
  });

  it("stops nothing when the pid of the server shown now runs another program", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], command: "/usr/bin/vim notes.txt" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.alive.has(4242)).toBe(true);
  });

  it("starts an Ovis already installed there through its launcher and updates it, instead of an installer that would keep its release", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], launcher: "systemd" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "replace" });
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: true }]);
  });

  it("knows the new Ovis by its new token even when it reuses an old process id", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], newPid: 4242 });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("connected");
  });

  it("cancels the connect it handed over to, and never reports a cancelled install as connected", async () => {
    const pc = fixture({});
    const gate = Promise.withResolvers<void>();
    pc.holdConnect(gate.promise);
    const started = pc.installer.start({ target });
    for (let i = 0; i < 100 && pc.installer.job(started.id)?.phase !== "connecting_pc"; i++) await Bun.sleep(1);
    pc.installer.cancel(started.id);
    gate.resolve();
    expect(await pc.settled(started)).toMatchObject({ phase: "cancelled" });
    expect(pc.cancelled()).toBe(1);
  });

  it("stops nothing when the server it was asked to replace is no longer the one there", async () => {
    const pc = fixture({ descriptors: [descriptor(4343)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
  });

  it("ends a cancelled install before anything more runs there", async () => {
    const pc = fixture({ neverStarts: true });
    const started = pc.installer.start({ target });
    pc.installer.cancel(started.id);
    const job = await pc.settled(started);
    expect(job.phase).toBe("cancelled");
    expect(pc.connects).toEqual([]);
  });
});
