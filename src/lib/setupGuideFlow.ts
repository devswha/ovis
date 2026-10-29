/**
 * Where the first-run setup guide stands (components/SetupGuide.tsx): the welcome, then Agent,
 * Plan usage, Phone and Alerts, each done or skipped, then Done. It opens by itself only on a fresh
 * install, and once: the record in this browser says it was closed, or where it was left.
 */
import type { AgentCatalogEntry, AgentCatalogRow } from "../../shared/agent-catalog.ts";

export type GuideStepId = "agent" | "usage" | "phone" | "alerts" | "done";
export const GUIDE_STEPS: readonly GuideStepId[] = ["agent", "usage", "phone", "alerts", "done"];
type CountedStep = Exclude<GuideStepId, "done">;

/** the subscription the user said they have; `free` is neither */
export type GuidePlan = "claude" | "chatgpt" | "free";
/** the agent the guide recommends for each plan, by catalog id (shared/agent-catalog.ts) */
export const PLAN_AGENT: Readonly<Record<GuidePlan, string>> = { claude: "claude", chatgpt: "codex", free: "opencode" };

export type StepOutcome = "done" | "skipped";

export interface GuideState {
  step: "welcome" | GuideStepId;
  outcomes: Partial<Record<CountedStep, StepOutcome>>;
  plan: GuidePlan | null;
  /** the catalog id of the agent being set up, or set up */
  agent: string | null;
  /** the agent's setup went through its sign-in */
  signedIn: boolean;
}

export type GuideEvent =
  /** I'm new to Ovis */
  | { type: "begin" }
  /** a plan's recommended agent, or one from Other agents (plan null) */
  | { type: "choose"; plan: GuidePlan | null; agent: string }
  | { type: "back" }
  | { type: "agent-ready"; signedIn: boolean }
  | { type: "complete" }
  | { type: "skip" };

export const WELCOME: GuideState = { step: "welcome", outcomes: {}, plan: null, agent: null, signedIn: false };
/** Settings → Setup guide opens it at its first step; what was set up before stays as it is */
export const REOPENED: GuideState = { ...WELCOME, step: "agent" };

function next(state: GuideState, outcome: StepOutcome, patch: Partial<GuideState> = {}): GuideState {
  const step = state.step;
  if (step === "welcome" || step === "done") return state;
  return { ...state, ...patch, outcomes: { ...state.outcomes, [step]: outcome }, step: GUIDE_STEPS[GUIDE_STEPS.indexOf(step) + 1]! };
}

export function guideStep(state: GuideState, event: GuideEvent): GuideState {
  switch (event.type) {
    case "begin":
      return state.step === "welcome" ? { ...state, step: "agent" } : state;
    case "choose":
      return state.step === "agent" ? { ...state, plan: event.plan, agent: event.agent, signedIn: false } : state;
    case "back":
      return state.step === "agent" ? { ...state, plan: null, agent: null, signedIn: false } : state;
    case "agent-ready":
      return state.step === "agent" && state.agent !== null ? next(state, "done", { signedIn: event.signedIn }) : state;
    case "complete":
      return next(state, "done");
    case "skip":
      return next(state, "skipped", state.step === "agent" ? { plan: null, agent: null, signedIn: false } : {});
  }
}

export interface ProgressSegment { id: GuideStepId; state: "done" | "skipped" | "now" | "next" }

/** The bar's five segments, and which of the four counted steps is shown (Done counts as the fourth). */
export function guideProgress(state: GuideState): { number: number | null; segments: ProgressSegment[] } {
  const at = state.step === "welcome" ? -1 : GUIDE_STEPS.indexOf(state.step);
  const segments = GUIDE_STEPS.map((id, index): ProgressSegment => {
    const outcome = id === "done" ? undefined : state.outcomes[id];
    return { id, state: index === at ? "now" : outcome ?? "next" };
  });
  return { number: at < 0 ? null : Math.min(at + 1, 4), segments };
}

/** The Agent step's look at the PC before its question: GET /api/agent-catalog, as far as it got. */
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

/** What the Agent step shows before an agent is chosen: the check, the agents found, or the question. */
export function agentView(check: PcCheck, installAnother: boolean): "checking" | "found" | "question" {
  if (check.failed) return "question";
  if (check.checking || check.catalog === null) return "checking";
  return !installAnother && foundAgents(check.catalog).length > 0 ? "found" : "question";
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

/** Plan usage starts switched on only right after a sign-in to the agent's account. */
export function usageOnByDefault(state: GuideState): boolean {
  return state.outcomes.agent === "done" && state.signedIn;
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
const OUTCOMES: ReadonlySet<unknown> = new Set(["done", "skipped"]);

function readState(value: unknown): GuideState | null {
  if (!isObject(value)) return null;
  const { step, outcomes, plan, agent, signedIn } = value;
  if (step !== "welcome" && !GUIDE_STEPS.includes(step as GuideStepId)) return null;
  if (!isObject(outcomes) || !Object.entries(outcomes).every(([key, outcome]) => GUIDE_STEPS.includes(key as GuideStepId) && key !== "done" && OUTCOMES.has(outcome))) return null;
  if (plan !== null && !(typeof plan === "string" && plan in PLAN_AGENT)) return null;
  if (agent !== null && typeof agent !== "string") return null;
  if (typeof signedIn !== "boolean") return null;
  return { step: step as GuideState["step"], outcomes: outcomes as GuideState["outcomes"], plan: plan as GuidePlan | null, agent, signedIn };
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
