/**
 * Where the first-run setup guide stands (components/SetupGuide.tsx): the welcome, then one setup
 * screen that checks the PC for coding agents and either starts the first workspace with one it found
 * or installs one. It opens by itself only on a fresh install, and once: the record in this browser
 * says it was closed, or that it was left open.
 */
import type { AgentCatalogEntry, AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { ProviderUsage } from "../../shared/usage.ts";

export interface GuideState {
  step: "welcome" | "setup";
}

/** I'm new to Ovis */
export type GuideEvent = { type: "begin" };

export const WELCOME: GuideState = { step: "welcome" };
/** Settings → Setup guide opens the setup screen itself */
export const REOPENED: GuideState = { step: "setup" };

export function guideStep(state: GuideState, event: GuideEvent): GuideState {
  return event.type === "begin" && state.step === "welcome" ? REOPENED : state;
}

/** The setup screen's look at the PC: GET /api/agent-catalog, as far as it got. */
export interface PcCheck {
  /** a check in flight, or its answer still settling on screen */
  checking: boolean;
  /** the last answer */
  catalog: readonly AgentCatalogRow[] | null;
  /** the last check failed */
  failed: boolean;
}

/** how long the check is on screen at least, so an instant answer is still seen */
export const CHECK_SETTLE_MS = 300;

/** How long an answer stays before the step moves on: what is left of CHECK_SETTLE_MS since the check began. */
export function settleDelay(startedAt: number, answeredAt: number): number {
  return Math.max(0, CHECK_SETTLE_MS - (answeredAt - startedAt));
}

/** The coding agents the PC surely has, in the catalog's order. */
export function foundAgents(catalog: readonly AgentCatalogRow[]): AgentCatalogRow[] {
  return catalog.filter((row) => row.kind === "harness" && row.state.installed === true);
}

/**
 * What the setup screen shows: the check, Start with the agents found, or an install. `ready` is an
 * agent installed from this screen that said it is ready: Start, before the PC is read again.
 */
export function setupView(check: PcCheck, ready: string | null): "checking" | "found" | "none" {
  if (ready !== null) return "found";
  if (check.failed) return "none";
  if (check.checking || check.catalog === null) return "checking";
  return foundAgents(check.catalog).length > 0 ? "found" : "none";
}

/** The agents Start offers: those the PC has, with `ready` first when the last answer does not list it yet. */
export function startAgents(catalog: readonly AgentCatalogRow[] | null, ready: string | null): AgentCatalogRow[] {
  const found = foundAgents(catalog ?? []);
  const readyRow = ready === null || found.some((agent) => agent.id === ready) ? undefined : catalog?.find((agent) => agent.id === ready);
  return readyRow === undefined ? found : [readyRow, ...found];
}

/** the agents Start picks first, in order, when none was just set up here */
const PREFERRED = ["claude", "codex"];

/** The agent Start picks: the one just set up here, else Claude Code, else Codex, else the first. */
export function preferredAgent(agents: readonly AgentCatalogRow[], ready: string | null): AgentCatalogRow | null {
  for (const id of [ready, ...PREFERRED]) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (agent !== undefined) return agent;
  }
  return agents[0] ?? null;
}

/** The plan accounts this PC is signed in to, which Start shows plan usage for without asking. */
export function signedInAccounts(providers: readonly ProviderUsage[]): number {
  return providers.filter((usage) => usage.problem !== "expired").length;
}

export type CheckStatus = { kind: "looking" } | { kind: "installed"; version: string | null } | { kind: "missing" } | { kind: "unknown" };

/** One agent's line in the check: undefined while the PC has not answered. */
export function checkStatus(row: AgentCatalogRow | undefined): CheckStatus {
  if (row === undefined) return { kind: "looking" };
  if (row.state.installed === true) return { kind: "installed", version: row.state.version };
  return row.state.installed === false ? { kind: "missing" } : { kind: "unknown" };
}

/** The check's lines: every coding agent this page knows while it looks, then each as the PC answered. */
export function checkList(known: readonly Pick<AgentCatalogEntry, "id" | "name" | "kind">[], answer: readonly AgentCatalogRow[] | null): { id: string; name: string; status: CheckStatus }[] {
  if (answer === null) return known.filter((entry) => entry.kind === "harness").map(({ id, name }) => ({ id, name, status: checkStatus(undefined) }));
  return answer.filter((row) => row.kind === "harness").map((row) => ({ id: row.id, name: row.name, status: checkStatus(row) }));
}

/** What says whether Ovis was used here before; null while it is not known yet. */
export interface FreshFacts {
  /** this PC's herdr workspaces */
  workspaces: number | null;
  /** this browser saved its settings (they are saved on the first change only) */
  savedSettings: boolean;
  /** GET /api/preferences: 0 until a browser of this server first shared a setting */
  sharedRevision: number | null;
  /** closed: a device was paired with this server */
  pairingGate: "open" | "closed" | "unavailable" | null;
  /** a watching device sets nothing up */
  watching: boolean;
}

export function autoOpen(facts: FreshFacts): boolean {
  if (facts.workspaces === null || facts.sharedRevision === null || facts.watching) return false;
  return facts.workspaces === 0 && !facts.savedSettings && facts.sharedRevision === 0 && facts.pairingGate !== "closed";
}

export const GUIDE_STORAGE_KEY = "ovis:setup-guide";

export type GuideRecord = { status: "open"; state: GuideState } | { status: "closed" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function readState(value: unknown): GuideState | null {
  if (!isObject(value)) return null;
  // the old multi-step guide's record (its outcomes, plan and agent) is no guide to show, even at its welcome
  if (Object.keys(value).length !== 1) return null;
  return value["step"] === "welcome" || value["step"] === "setup" ? { step: value["step"] } : null;
}

/** This browser's record of the guide; a damaged one reads as closed, so it never opens by itself on it. */
export function readGuide(storage: Pick<Storage, "getItem">): GuideRecord | null {
  let raw: string | null;
  try { raw = storage.getItem(GUIDE_STORAGE_KEY); } catch { return null; }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (isObject(value) && value["status"] === "open") {
      const state = readState(value["state"]);
      if (state !== null) return { status: "open", state };
    }
  } catch { /* damaged: closed */ }
  return { status: "closed" };
}

/** Keeps where the guide is (a reload resumes there), or with null that it was closed; the record written, or null when storage refused it. */
export function saveGuide(storage: Pick<Storage, "setItem">, state: GuideState | null): string | null {
  const record = JSON.stringify(state === null ? { status: "closed" } : { status: "open", state });
  try {
    storage.setItem(GUIDE_STORAGE_KEY, record);
    return record;
  } catch { return null; /* private mode: the guide lasts for the page */ }
}
