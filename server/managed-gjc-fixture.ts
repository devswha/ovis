import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import type { PaneProcessInfo } from "../shared/herdr-api.generated.ts";
import type { LiveManagedProcess } from "./managed-gjc-process.ts";
import type { ManagedGjcDeps } from "./managed-gjc-session.ts";

export function makeManagedGjcFixture() {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".managed-gjc-test-")));
  const namespace = join(root, "managed");
  const cwd = join(root, "project");
  const nonce = "a".repeat(32);
  const sessionDir = join(namespace, `${nonce}.sessions`);
  const managerDir = join(root, "manager");
  const launchDir = join(root, "launch");
  const bunPath = join(root, "runtime", "bun", "bin", "bun.exe");
  const bunLauncher = join(launchDir, "bin", "bun");
  const gjcPath = join(root, "runtime", "node_modules", "@gajae-code", "coding-agent", "bin", "gjc.js");
  const gjcLauncher = join(launchDir, ".local", "bin", "gjc");
  mkdirSync(namespace, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(sessionDir, { mode: 0o700 });
  mkdirSync(managerDir, { mode: 0o700 });
  mkdirSync(join(launchDir, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(launchDir, ".local", "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "runtime", "bun", "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "runtime", "node_modules", "@gajae-code", "coding-agent", "bin"), { recursive: true, mode: 0o700 });
  chmodSync(namespace, 0o700);
  chmodSync(sessionDir, 0o700);
  const managedPty = join(managerDir, "managed_pty.py");
  const managedSessions = join(managerDir, "managed_sessions.py");
  const sessionIdentity = join(managerDir, "session_identity.py");
  const packageFile = join(root, "runtime", "node_modules", "@gajae-code", "coding-agent", "package.json");
  const sdkModule = join(root, "runtime", "node_modules", "@gajae-code", "coding-agent", "src", "session", "session-manager.ts");
  writeFileSync(managedPty, "# fixture\n");
  writeFileSync(managedSessions, "# fixture\n");
  writeFileSync(sessionIdentity, "# fixture\n");
  writeFileSync(bunPath, "bun fixture runtime\n");
  writeFileSync(gjcPath, "gjc fixture runtime\n");
  mkdirSync(join(root, "runtime", "node_modules", "@gajae-code", "coding-agent", "src", "session"), { recursive: true, mode: 0o700 });
  writeFileSync(packageFile, "{\"name\":\"@gajae-code/coding-agent\"}\n");
  writeFileSync(sdkModule, "export {}\n");
  symlinkSync(bunPath, bunLauncher);
  symlinkSync(gjcPath, gjcLauncher);
  const sessionFile = join(sessionDir, "native-session.jsonl");
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const transcript = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, cwd }),
    JSON.stringify({ type: "message", id: "m1", timestamp: "2026-10-31T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "synthetic user prompt" }] } }),
    JSON.stringify({ type: "message", id: "m2", timestamp: "2026-10-31T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "synthetic assistant reply" }] } }),
  ].join("\n") + "\n";
  writeFileSync(sessionFile, transcript, { mode: 0o600 });
  chmodSync(sessionFile, 0o600);
  const pin = statSync(sessionFile);
  const recordPath = join(namespace, `${nonce}.json`);
  const uid = process.getuid?.() ?? 1000;
  const cgroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/herdr-agent-${nonce}.service`;
  const broker = { pid: 51001, starttime: "101", boot: "fixture-boot", cwd, cgroup, exe: "/usr/bin/python3" };
  const bunExecutable = realpathSync(bunLauncher);
  const gjcEntry = realpathSync(gjcLauncher);
  const argv = [bunExecutable, gjcEntry, "--session-dir", sessionDir];
  const child = { pid: 51002, starttime: "102", boot: "fixture-boot", cwd, cgroup, exe: bunExecutable };
  const wrapperPid = 51003;
  const runtimePin = (path: string): string => {
    const canonical = realpathSync(path);
    return `${canonical}:${createHash("sha256").update(readFileSync(canonical)).digest("hex")}`;
  };
  const record: Record<string, unknown> = {
    schema: 2, nonce, generation: 1, engine_generation: 1, harness: "gjc", launcher_harness: "gjc",
    cwd, pane_id: "pane-1", workspace_id: "workspace-1", terminal_id: "terminal-1",
    session_dir: sessionDir, session_file: sessionFile, session_id: sessionId,
    file_identity: { dev: pin.dev, ino: pin.ino }, broker, child, argv,
    env: { HOME: root, PATH: "/usr/bin", GJC_CODING_AGENT_DIR: join(root, ".gjc", "agent"), HERDR_SESSION: "phase1" },
    runtime: {
      [bunLauncher]: runtimePin(bunLauncher), [gjcLauncher]: runtimePin(gjcLauncher), [packageFile]: runtimePin(packageFile),
      [sdkModule]: runtimePin(sdkModule), [managedPty]: runtimePin(managedPty),
      [managedSessions]: runtimePin(managedSessions), [sessionIdentity]: runtimePin(sessionIdentity),
    },
    state: "ready", desired_state: "running", server_session: "phase1",
  };
  const writeRecord = (value: Record<string, unknown> = record): void => {
    writeFileSync(recordPath, JSON.stringify(value), { mode: 0o600 });
    chmodSync(recordPath, 0o600);
  };
  writeRecord();
  const pane: HerdrPane = {
    pane_id: "pane-1", workspace_id: "workspace-1", tab_id: "tab-1", terminal_id: "terminal-1",
    agent_status: "working", focused: false, revision: 1, cwd, tokens: { hm_managed_session: nonce, hm_managed_generation: "1" },
  };
  const attachArgv = ["/usr/bin/python3", managedPty, "attach", "--record", recordPath,
    "--generation", "1", "--terminal", "terminal-1"];
  const processInfo: PaneProcessInfo = {
    pane_id: pane.pane_id,
    foreground_processes: [{ pid: wrapperPid, name: "python3", argv: attachArgv, cwd }],
  };
  const live = new Map<number, LiveManagedProcess>([
    [broker.pid, { ...broker, parentPid: 1, argv: ["/usr/bin/python3", managedPty, "serve", "--record", recordPath] }],
    [child.pid, { ...child, parentPid: broker.pid, argv }],
    [wrapperPid, { pid: wrapperPid, starttime: "103", boot: "fixture-boot", cwd, cgroup: "/user.slice/ovis-test.scope", exe: "/usr/bin/python3", parentPid: 1, argv: attachArgv }],
  ]);
  return {
    root, namespace, cwd, sessionFile, recordPath, record, writeRecord, pane, processInfo, live, runtimeProofFile: packageFile,
    sdkSessionId: sessionId, sdkPid: child.pid, sdkBirth: child.starttime,
    snapshot(): SessionSnapshot { return { protocol: 22, version: "fixture", panes: [this.pane], agents: [], layouts: [], tabs: [], workspaces: [] }; },
  };
}

export type ManagedGjcFixture = ReturnType<typeof makeManagedGjcFixture>;

export const managedGjcDependencies = (fixture: ManagedGjcFixture): ManagedGjcDeps => ({
  namespace: fixture.namespace,
  paneById: async () => fixture.pane,
  processInfo: async () => fixture.processInfo,
  processIdentity: pid => fixture.live.get(pid) ?? null,
  sdkSession: async (_record, _pid) => ({
    sessionId: fixture.sdkSessionId, pid: fixture.sdkPid,
    hostIncarnation: `linux:${fixture.sdkBirth}`, endpointGeneration: 3,
  }),
});

export function disposeManagedGjcFixture(fixture: ManagedGjcFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}
