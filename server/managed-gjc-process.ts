import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { PaneProcessInfo } from "../shared/herdr-api.generated.ts";
import { ManagedGjcProofFailure, type ManagedGjcEvidence, type ManagedGjcProcessPin } from "./managed-gjc-record.ts";

export interface LiveManagedProcess {
  readonly pid: number; readonly starttime: string; readonly boot: string; readonly cwd: string;
  readonly cgroup: string; readonly exe: string; readonly parentPid: number; readonly argv: readonly string[];
}

function fail(reason: string): never { throw new ManagedGjcProofFailure(reason); }
function isNodeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}
function samePin(pin: ManagedGjcProcessPin, process: LiveManagedProcess): boolean {
  return pin.pid === process.pid && pin.starttime === process.starttime && pin.boot === process.boot
    && pin.cwd === process.cwd && pin.cgroup === process.cgroup && pin.exe === process.exe;
}
function argsAt(pid: number): readonly string[] | null {
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0");
    if (parts.at(-1) === "") parts.pop();
    return parts.length > 0 ? parts : null;
  } catch (error) {
    if (isNodeError(error)) return null;
    throw error;
  }
}

export function liveManagedProcess(pid: number): LiveManagedProcess | null {
  if (process.platform !== "linux" || process.getuid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const proc = `/proc/${pid}`;
    const directory = statSync(proc);
    if (directory.uid !== process.getuid()) return null;
    const statText = readFileSync(join(proc, "stat"), "utf8");
    const fields = statText.slice(statText.lastIndexOf(") ") + 2).trim().split(/\s+/);
    const starttime = fields[19];
    const parentPid = Number(fields[1]);
    const state = fields[0];
    const cgroup = readFileSync(join(proc, "cgroup"), "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3);
    const argv = argsAt(pid);
    if (state === "Z" || starttime === undefined || !/^\d+$/.test(starttime)
      || !Number.isSafeInteger(parentPid) || parentPid < 0 || !cgroup || !argv) return null;
    return {
      pid, starttime, parentPid, cgroup, argv,
      boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      cwd: realpathSync(readlinkSync(join(proc, "cwd"))),
      exe: readlinkSync(join(proc, "exe")),
    };
  } catch (error) {
    if (isNodeError(error)) return null;
    throw error;
  }
}

function managedPtyScript(evidence: ManagedGjcEvidence): string {
  const paths = Object.keys(evidence.record.runtime).filter(path => basename(path) === "managed_pty.py");
  if (paths.length !== 1 || !paths[0]) fail("blocked_runtime_identity");
  const path = paths[0];
  if (realpathSync(path) !== path) fail("blocked_runtime_identity");
  return path;
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

/** Binds the saved broker and child to the live unit, and the current pane to its exact attach wrapper. */
export function managedGjcProcesses(
  evidence: ManagedGjcEvidence,
  paneId: string,
  info: PaneProcessInfo | null,
  readProcess: (pid: number) => LiveManagedProcess | null = liveManagedProcess,
): LiveManagedProcess {
  const { record } = evidence;
  const broker = readProcess(record.broker.pid);
  const child = readProcess(record.child.pid);
  if (!broker || !child || !samePin(record.broker, broker) || !samePin(record.child, child)
    || broker.pid === child.pid || child.parentPid !== broker.pid || broker.cgroup !== child.cgroup
    || !broker.cgroup.endsWith(`/herdr-agent-${record.nonce}.service`)) fail("blocked_runtime_identity");
  const resumedArgs = [...record.argv, "--resume", record.sessionFile];
  if ((!sameArgs(child.argv, record.argv) && !sameArgs(child.argv, resumedArgs))
    || child.argv[0] !== child.exe) fail("blocked_child_identity");

  const script = managedPtyScript(evidence);
  const brokerArgs = ["/usr/bin/python3", script, "serve", "--record", record.recordPath];
  if (!sameArgs(broker.argv, brokerArgs)) fail("blocked_broker_identity");
  if (info === null || info.pane_id !== paneId || !Array.isArray(info.foreground_processes)) fail("blocked_pane_process_info");
  const attachArgs = ["/usr/bin/python3", script, "attach", "--record", record.recordPath,
    "--generation", String(record.generation), "--terminal", record.terminalId];
  const attached = info.foreground_processes.filter(process => Array.isArray(process.argv)
    && sameArgs(process.argv, attachArgs) && process.cwd === record.cwd);
  if (attached.length !== 1) fail("blocked_pane_wrapper");
  const wrapperInfo = attached[0];
  if (!wrapperInfo || !Number.isSafeInteger(wrapperInfo.pid) || wrapperInfo.pid <= 0) fail("blocked_pane_wrapper");
  const wrapper = readProcess(wrapperInfo.pid);
  if (!wrapper || wrapper.cwd !== record.cwd || !sameArgs(wrapper.argv, attachArgs)) fail("blocked_pane_wrapper");
  return wrapper;
}

export function sameLiveManagedProcess(left: LiveManagedProcess, right: LiveManagedProcess): boolean {
  return left.pid === right.pid && left.starttime === right.starttime && left.boot === right.boot
    && left.cwd === right.cwd && left.cgroup === right.cgroup && left.exe === right.exe
    && left.parentPid === right.parentPid && sameArgs(left.argv, right.argv);
}
