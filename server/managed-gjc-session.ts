import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { PaneProcessInfo } from "../shared/herdr-api.generated.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { type GjcSdkCommandRunner, type GjcSdkSessionIdentity, gjcSdkCurrentSessionWithRunner } from "./gjc-sdk.ts";
import { GjcSdkLookupError } from "./gjc-sdk-error.ts";
import { gjcSdkGenerationCurrent } from "./gjc-sdk-generation.ts";
import { HerdrError, paneProcessInfo, sessionSnapshot } from "./herdr/client.ts";
import { liveManagedProcess, managedGjcProcesses, sameLiveManagedProcess, type LiveManagedProcess } from "./managed-gjc-process.ts";
import {
  ManagedGjcProofFailure, readManagedGjcEvidence, type ManagedGjcEvidence, type ManagedGjcRecord,
  sameManagedGjcPane,
} from "./managed-gjc-record.ts";

const execFileAsync = promisify(execFile);
type ManagedSdkLookup = (record: ManagedGjcRecord, pid: number, cwd: string, agentDir: string) => Promise<GjcSdkSessionIdentity | null>;

export interface ManagedGjcDeps {
  readonly namespace?: string;
  readonly paneById?: (paneId: string) => Promise<HerdrPane | null>;
  readonly processInfo?: (paneId: string) => Promise<PaneProcessInfo | null>;
  readonly processIdentity?: (pid: number) => LiveManagedProcess | null;
  readonly sdkSession?: ManagedSdkLookup;
}

export interface ManagedGjcBinding {
  readonly evidence: ManagedGjcEvidence;
  readonly wrapper: LiveManagedProcess;
  readonly identity: { readonly id: string; readonly generation: number; readonly sessionId: string };
  readonly sdkIdentity: GjcSdkSessionIdentity;
}

export type ManagedGjcResolution =
  | { readonly state: "ready"; readonly binding: ManagedGjcBinding }
  | { readonly state: "identity_pending"; readonly reason: string }
  | { readonly state: "blocked"; readonly reason: string };

function failure(error: unknown): string | null {
  if (error instanceof ManagedGjcProofFailure) return error.reason;
  if (error instanceof SyntaxError) return "blocked_record_invalid";
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code === "ENOENT" ? "blocked_record_missing" : "blocked_managed_record_unavailable";
  }
  return null;
}

function managedNamespace(): string {
  return process.env["HERDR_MANAGED_NAMESPACE"] ?? join(homedir(), "dev/agents/herdr_manager/state/managed-sessions");
}

function unavailable(error: unknown): boolean {
  return error instanceof HerdrError || error instanceof TypeError;
}

async function currentPane(paneId: string, deps: ManagedGjcDeps): Promise<HerdrPane | null> {
  if (deps.paneById) return deps.paneById(paneId);
  try {
    const snapshot = await sessionSnapshot();
    return snapshot.panes.find(pane => pane.pane_id === paneId) ?? null;
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
}

async function currentProcessInfo(paneId: string, deps: ManagedGjcDeps): Promise<PaneProcessInfo | null> {
  if (deps.processInfo) return deps.processInfo(paneId);
  try {
    return (await paneProcessInfo(paneId)) ?? null;
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
}

function agentDirectory(record: ManagedGjcRecord): string {
  const home = record.env.HOME ?? homedir();
  const value = record.env.GJC_CODING_AGENT_DIR ?? join(home, ".gjc", "agent");
  if (!isAbsolute(value)) throw new ManagedGjcProofFailure("blocked_sdk_root");
  return value;
}

function sdkEnvironment(record: ManagedGjcRecord, agentDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "TERM", "LANG", "GJC_CODING_AGENT_DIR", "HERDR_SESSION", "HERDR_MANAGED_NAMESPACE"] as const) {
    const value = record.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment["GJC_CODING_AGENT_DIR"] = agentDir;
  environment["GJC_SDK_BROKER_AUTOSTART"] = "0";
  return environment;
}

const sdkRunners = new Map<string, GjcSdkCommandRunner>();

/** Reuse the SDK's bounded roster cache without caching its per-lookup generation proof. */
export function managedGjcSdkRunner(record: ManagedGjcRecord, agentDir: string): GjcSdkCommandRunner {
  const [runtime, cli] = record.argv;
  if (runtime === undefined || cli === undefined) throw new ManagedGjcProofFailure("blocked_runtime_identity");
  const env = sdkEnvironment(record, agentDir);
  const key = JSON.stringify([runtime, cli, env, Object.entries(record.runtime)]);
  const cached = sdkRunners.get(key);
  if (cached) return cached;
  const runner: GjcSdkCommandRunner = async (_command, args, options) => {
    const result = await execFileAsync(runtime, [cli, ...args], { ...options, env });
    return result.stdout;
  };
  if (sdkRunners.size >= 32) sdkRunners.delete(sdkRunners.keys().next().value!);
  sdkRunners.set(key, runner);
  return runner;
}

async function sdkSession(record: ManagedGjcRecord, pid: number, cwd: string, agentDir: string): Promise<GjcSdkSessionIdentity | null> {
  const cli = record.argv[1];
  if (cli === undefined) throw new ManagedGjcProofFailure("blocked_runtime_identity");
  const runner = managedGjcSdkRunner(record, agentDir);
  const generationCurrent = (directory: string, sessionId: string, generation: number): Promise<boolean> =>
    gjcSdkGenerationCurrent(directory, sessionId, generation, undefined, cli);
  return gjcSdkCurrentSessionWithRunner([pid], cwd, agentDir, runner, undefined, undefined, generationCurrent);
}

function sameEvidence(left: ManagedGjcEvidence, right: ManagedGjcEvidence): boolean {
  return left.bindingDigest === right.bindingDigest
    && left.record.sessionFile === right.record.sessionFile
    && left.record.sessionId === right.record.sessionId;
}

function sameSdkIdentity(left: GjcSdkSessionIdentity, right: GjcSdkSessionIdentity): boolean {
  return left.pid === right.pid && left.sessionId === right.sessionId
    && left.hostIncarnation === right.hostIncarnation && left.endpointGeneration === right.endpointGeneration;
}

/** Resolve only a manager-tagged pane; no token means the existing native GJC path keeps ownership. */
export async function resolveManagedGjcSession(
  pane: HerdrPane,
  deps: ManagedGjcDeps = {},
): Promise<ManagedGjcResolution | null> {
  const namespace = deps.namespace ?? managedNamespace();
  try {
    const evidence = readManagedGjcEvidence(pane, namespace);
    if (evidence === null) return null;
    const info = await currentProcessInfo(pane.pane_id, deps);
    const wrapper = managedGjcProcesses(evidence, pane.pane_id, info, deps.processIdentity ?? liveManagedProcess);
    const live = await (deps.sdkSession ?? sdkSession)(evidence.record, evidence.record.child.pid,
      evidence.record.cwd, agentDirectory(evidence.record));
    if (live === null) return { state: "identity_pending", reason: "identity_pending" };
    if (live.pid !== evidence.record.child.pid || live.sessionId !== evidence.record.sessionId
      || live.hostIncarnation !== `linux:${evidence.record.child.starttime}`
      || !Number.isSafeInteger(live.endpointGeneration) || live.endpointGeneration < 1) {
      return { state: "blocked", reason: "blocked_gjc_session_mismatch" };
    }

    const freshPane = await currentPane(pane.pane_id, deps);
    if (freshPane === null || !sameManagedGjcPane(pane, freshPane)) return { state: "blocked", reason: "blocked_pane_identity" };
    const freshInfo = await currentProcessInfo(pane.pane_id, deps);
    // The roster lookup includes the SDK generation proof; perform it after all
    // asynchronous pane checks, then re-read local evidence without another await.
    const freshLive = await (deps.sdkSession ?? sdkSession)(evidence.record, evidence.record.child.pid,
      evidence.record.cwd, agentDirectory(evidence.record));
    if (freshLive === null || !sameSdkIdentity(live, freshLive)) return { state: "blocked", reason: "blocked_gjc_session_mismatch" };
    const freshEvidence = readManagedGjcEvidence(freshPane, namespace);
    const freshWrapper = freshEvidence === null ? null
      : managedGjcProcesses(freshEvidence, pane.pane_id, freshInfo, deps.processIdentity ?? liveManagedProcess);
    if (freshEvidence === null || !sameEvidence(evidence, freshEvidence) || freshWrapper === null
      || !sameLiveManagedProcess(wrapper, freshWrapper)) return { state: "blocked", reason: "blocked_managed_identity_changed" };

    return {
      state: "ready",
      binding: {
        evidence,
        wrapper,
        identity: { id: evidence.record.nonce, generation: evidence.record.generation, sessionId: evidence.record.sessionId },
        sdkIdentity: live,
      },
    };
  } catch (error) {
    if (error instanceof GjcSdkLookupError) return { state: "identity_pending", reason: "identity_pending" };
    const reason = failure(error);
    if (reason !== null) return { state: "blocked", reason };
    throw error;
  }
}

export async function assertManagedGjcCurrent(
  pane: HerdrPane,
  expected: ManagedGjcBinding,
  deps: ManagedGjcDeps = {},
): Promise<void> {
  const current = await resolveManagedGjcSession(pane, deps);
  if (current?.state !== "ready" || !sameEvidence(expected.evidence, current.binding.evidence)
    || !sameLiveManagedProcess(expected.wrapper, current.binding.wrapper)
    || !sameSdkIdentity(expected.sdkIdentity, current.binding.sdkIdentity)) {
    throw new ManagedGjcProofFailure("blocked_managed_identity_changed");
  }
}
