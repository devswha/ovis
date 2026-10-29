import { describe, expect, it } from "bun:test";

import { AGENT_CATALOG, catalogRow, type AgentCatalogRow, type AgentInstallState } from "../../shared/agent-catalog.ts";
import { onSetupGuideRequest, openSetupGuide } from "./setupGuide.ts";
import { agentView, autoOpen, CHECK_SETTLE_MS, checkList, checkStatus, foundAgents, settleDelay, guideProgress, guideStep, readGuide, saveGuide, usageOnByDefault, WELCOME, type FreshFacts, type GuideState, type PcCheck } from "./setupGuideFlow.ts";

const FRESH: FreshFacts = { workspaces: 0, savedSettings: false, sharedRevision: 0, pairingGate: "open", watching: false };

const memory = (): Pick<Storage, "getItem" | "setItem"> & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

const walk = (state: GuideState, ...events: Parameters<typeof guideStep>[1][]): GuideState => events.reduce(guideStep, state);

describe("autoOpen", () => {
  it("opens the welcome on a fresh install only", () => {
    expect(autoOpen(FRESH)).toBe(true);
    // a server whose pairing state is not known has no paired device to show for it
    expect(autoOpen({ ...FRESH, pairingGate: "unavailable" })).toBe(true);
  });

  it("stays shut once anything shows Ovis was used here before", () => {
    expect(autoOpen({ ...FRESH, workspaces: 1 })).toBe(false);
    expect(autoOpen({ ...FRESH, savedSettings: true })).toBe(false);
    expect(autoOpen({ ...FRESH, sharedRevision: 3 })).toBe(false);
    expect(autoOpen({ ...FRESH, pairingGate: "closed" })).toBe(false);
    expect(autoOpen({ ...FRESH, watching: true })).toBe(false);
  });

  it("does not guess while a fact is still unknown", () => {
    expect(autoOpen({ ...FRESH, workspaces: null })).toBe(false);
    expect(autoOpen({ ...FRESH, sharedRevision: null })).toBe(false);
  });
});

describe("guideStep", () => {
  it("walks Agent, Plan usage, Phone, Alerts to Done, recording each outcome", () => {
    const agent = walk(WELCOME, { type: "begin" });
    expect(agent.step).toBe("agent");
    const chosen = guideStep(agent, { type: "choose", plan: "claude", agent: "claude" });
    expect(chosen).toMatchObject({ step: "agent", plan: "claude", agent: "claude" });
    const done = walk(chosen, { type: "agent-ready", signedIn: true }, { type: "complete" }, { type: "skip" }, { type: "complete" });
    expect(done.step).toBe("done");
    expect(done.outcomes).toEqual({ agent: "done", usage: "done", phone: "skipped", alerts: "done" });
    expect(done.signedIn).toBe(true);
  });

  it("skips the agent step without an agent, and Back forgets the pick", () => {
    const chosen = walk(WELCOME, { type: "begin" }, { type: "choose", plan: "free", agent: "opencode" });
    expect(guideStep(chosen, { type: "back" })).toMatchObject({ step: "agent", plan: null, agent: null });
    const skipped = guideStep(chosen, { type: "skip" });
    expect(skipped).toMatchObject({ step: "usage", agent: null, outcomes: { agent: "skipped" } });
  });

  it("ignores events that do not belong to the step shown", () => {
    expect(guideStep(WELCOME, { type: "skip" })).toBe(WELCOME);
    expect(guideStep(WELCOME, { type: "agent-ready", signedIn: true })).toBe(WELCOME);
    const usage = walk(WELCOME, { type: "begin" }, { type: "skip" });
    expect(guideStep(usage, { type: "agent-ready", signedIn: true })).toBe(usage);
    const end = walk(usage, { type: "skip" }, { type: "skip" }, { type: "skip" });
    expect(end.step).toBe("done");
    expect(guideStep(end, { type: "skip" })).toBe(end);
  });
});

describe("guideProgress", () => {
  it("numbers the four steps and marks skipped ones", () => {
    const alerts = walk(WELCOME, { type: "begin" }, { type: "choose", plan: "chatgpt", agent: "codex" }, { type: "agent-ready", signedIn: false }, { type: "complete" }, { type: "skip" });
    const progress = guideProgress(alerts);
    expect(progress.number).toBe(4);
    expect(progress.segments.map((segment) => `${segment.id}:${segment.state}`)).toEqual(["agent:done", "usage:done", "phone:skipped", "alerts:now", "done:next"]);
    expect(guideProgress(walk(alerts, { type: "complete" })).number).toBe(4);
  });
});

describe("usageOnByDefault", () => {
  it("is on only after a sign-in in the agent step", () => {
    const chosen = walk(WELCOME, { type: "begin" }, { type: "choose", plan: "claude", agent: "claude" });
    expect(usageOnByDefault(guideStep(chosen, { type: "agent-ready", signedIn: true }))).toBe(true);
    expect(usageOnByDefault(guideStep(chosen, { type: "agent-ready", signedIn: false }))).toBe(false);
    expect(usageOnByDefault(guideStep(chosen, { type: "skip" }))).toBe(false);
  });
});

describe("readGuide and saveGuide", () => {
  it("keeps an open guide to resume and a closed one to stay shut", () => {
    const storage = memory();
    expect(readGuide(storage)).toBeNull();
    const usage = walk(WELCOME, { type: "begin" }, { type: "skip" });
    saveGuide(storage, usage);
    expect(readGuide(storage)).toEqual({ status: "open", state: usage });
    saveGuide(storage, null);
    expect(readGuide(storage)).toEqual({ status: "closed" });
  });

  it("reads a damaged record as closed, never as a guide to show", () => {
    const storage = memory();
    for (const raw of ["{", "[]", "{\"status\":\"open\",\"state\":{\"step\":\"nowhere\"}}", "{\"status\":\"open\"}"]) {
      storage.values.set("ovis:setup-guide", raw);
      expect(readGuide(storage)).toEqual({ status: "closed" });
    }
  });

});

const MISSING: AgentInstallState = { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null };
const row = (id: string, state: Partial<AgentInstallState> = {}): AgentCatalogRow => catalogRow(AGENT_CATALOG.find((entry) => entry.id === id)!, "linux", { ...MISSING, ...state });
const installed = (id: string, version: string | null = "1.0.0"): AgentCatalogRow => row(id, { installed: true, binary: id, on_path: true, version });
/** what the PC answered: every catalog agent, none installed but those given */
const answer = (...found: AgentCatalogRow[]): AgentCatalogRow[] => AGENT_CATALOG.map((entry) => found.find((one) => one.id === entry.id) ?? row(entry.id));
const check = (patch: Partial<PcCheck>): PcCheck => ({ checking: false, catalog: null, failed: false, ...patch });

describe("the PC check before the Agent question", () => {
  it("shows the check while it runs, and before it has started", () => {
    expect(agentView(check({ checking: true }), false)).toBe("checking");
    expect(agentView(check({}), false)).toBe("checking");
    // the answer is in but still settling on screen
    expect(agentView(check({ checking: true, catalog: answer(installed("claude")) }), false)).toBe("checking");
  });

  it("lists the coding agents the PC has once the check is done", () => {
    expect(agentView(check({ catalog: answer(installed("codex"), installed("claude")) }), false)).toBe("found");
    // in the catalog's order, coding agents only, and only those surely there
    const catalog = answer(installed("codex"), installed("claude"), installed("hermes"), row("pi", { installed: null }));
    expect(foundAgents(catalog).map((agent) => agent.id)).toEqual(["claude", "codex"]);
  });

  it("asks the question when the PC has no coding agent", () => {
    expect(agentView(check({ catalog: answer() }), false)).toBe("question");
    // an assistant is not a coding agent for a workspace
    expect(agentView(check({ catalog: answer(installed("hermes")) }), false)).toBe("question");
  });

  it("falls back to the question when the check failed", () => {
    expect(agentView(check({ failed: true }), false)).toBe("question");
    expect(agentView(check({ failed: true, catalog: answer(installed("claude")) }), false)).toBe("question");
  });

  it("asks the question when the user wants to install another agent", () => {
    expect(agentView(check({ catalog: answer(installed("claude")) }), true)).toBe("question");
  });

  it("says for each agent whether it is still being looked for, there, or not", () => {
    expect(checkStatus(undefined)).toEqual({ kind: "looking" });
    expect(checkStatus(installed("claude", "2.1.311"))).toEqual({ kind: "installed", version: "2.1.311" });
    expect(checkStatus(installed("claude", null))).toEqual({ kind: "installed", version: null });
    expect(checkStatus(row("claude"))).toEqual({ kind: "missing" });
    expect(checkStatus(row("claude", { installed: null }))).toEqual({ kind: "unknown" });
  });

  it("keeps an instant answer on screen briefly, and adds nothing to a slow check", () => {
    expect(settleDelay(1000, 1000)).toBe(CHECK_SETTLE_MS);
    expect(settleDelay(1000, 1000 + CHECK_SETTLE_MS - 100)).toBe(100);
    expect(settleDelay(1000, 1000 + CHECK_SETTLE_MS)).toBe(0);
    expect(settleDelay(1000, 3000)).toBe(0);
  });

  it("lists every coding agent while looking, then each as the PC answered", () => {
    const listed = checkList(AGENT_CATALOG, null);
    expect(listed.map((one) => one.id)).toEqual(AGENT_CATALOG.filter((entry) => entry.kind === "harness").map((entry) => entry.id));
    expect(listed.every((one) => one.status.kind === "looking")).toBe(true);
    const answered = checkList(AGENT_CATALOG, answer(installed("codex", "0.163.0")));
    expect(answered.find((one) => one.id === "codex")).toEqual({ id: "codex", name: "Codex", status: { kind: "installed", version: "0.163.0" } });
    expect(answered.find((one) => one.id === "claude")?.status).toEqual({ kind: "missing" });
    // an agent the PC answered that this page's list lacks still shows
    const extra = { ...installed("claude"), id: "newcomer", name: "Newcomer" };
    expect(checkList(AGENT_CATALOG, [...answer(), extra]).at(-1)).toEqual({ id: "newcomer", name: "Newcomer", status: { kind: "installed", version: "1.0.0" } });
  });
});

describe("openSetupGuide", () => {
  it("reaches every listener until it unsubscribes", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
    try {
      let calls = 0;
      const stop = onSetupGuideRequest(() => { calls += 1; });
      openSetupGuide();
      expect(calls).toBe(1);
      stop();
      openSetupGuide();
      expect(calls).toBe(1);
    } finally {
      if (saved) Object.defineProperty(globalThis, "window", saved);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
