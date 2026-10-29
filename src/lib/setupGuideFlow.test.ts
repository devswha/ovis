import { describe, expect, it } from "bun:test";

import { AGENT_CATALOG, catalogRow, type AgentCatalogRow, type AgentInstallState } from "../../shared/agent-catalog.ts";
import type { ProviderUsage } from "../../shared/usage.ts";
import { onSetupGuideRequest, openSetupGuide } from "./setupGuide.ts";
import { autoOpen, CHECK_SETTLE_MS, checkList, checkStatus, foundAgents, guideStep, preferredAgent, readGuide, readSignedIn, REOPENED, saveGuide, settleDelay, setupView, signedInAccounts, startAgents, WELCOME, type FreshFacts, type PcCheck } from "./setupGuideFlow.ts";

const FRESH: FreshFacts = { workspaces: 0, savedSettings: false, sharedRevision: 0, pairingGate: "open", watching: false };

const memory = (): Pick<Storage, "getItem" | "setItem"> & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

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
  it("goes from the welcome to the one setup screen, and Settings opens that screen", () => {
    expect(guideStep(WELCOME, { type: "begin" })).toEqual({ step: "setup" });
    expect(REOPENED).toEqual({ step: "setup" });
    const setup = guideStep(WELCOME, { type: "begin" });
    expect(guideStep(setup, { type: "begin" })).toBe(setup);
  });
});

describe("readGuide and saveGuide", () => {
  it("keeps an open guide to resume and a closed one to stay shut", () => {
    const storage = memory();
    expect(readGuide(storage)).toBeNull();
    saveGuide(storage, REOPENED);
    expect(readGuide(storage)).toEqual({ status: "open", state: REOPENED });
    saveGuide(storage, null);
    expect(readGuide(storage)).toEqual({ status: "closed" });
  });

  it("reads a damaged record as closed, never as a guide to show", () => {
    const storage = memory();
    // a record of the old multi-step guide is no guide to show either
    for (const raw of ["{", "[]", "{\"status\":\"open\",\"state\":{\"step\":\"nowhere\"}}", "{\"status\":\"open\"}", "{\"status\":\"open\",\"state\":{\"step\":\"agent\"}}", "{\"status\":\"open\",\"state\":{\"step\":\"welcome\",\"outcomes\":{},\"plan\":null,\"agent\":null,\"signedIn\":false}}"]) {
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

describe("the setup screen after the PC check", () => {
  it("shows the check while it runs, and before it has started", () => {
    expect(setupView(check({ checking: true }), null)).toBe("checking");
    expect(setupView(check({}), null)).toBe("checking");
    // the answer is in but still settling on screen
    expect(setupView(check({ checking: true, catalog: answer(installed("claude")) }), null)).toBe("checking");
  });

  it("goes straight to Start when the PC has a coding agent", () => {
    expect(setupView(check({ catalog: answer(installed("codex")) }), null)).toBe("found");
    // in the catalog's order, coding agents only, and only those surely there
    const catalog = answer(installed("codex"), installed("claude"), installed("hermes"), row("pi", { installed: null }));
    expect(foundAgents(catalog).map((agent) => agent.id)).toEqual(["claude", "codex"]);
  });

  it("offers an install when the PC has no coding agent, or the check failed", () => {
    expect(setupView(check({ catalog: answer() }), null)).toBe("none");
    // an assistant is not a coding agent for a workspace
    expect(setupView(check({ catalog: answer(installed("hermes")) }), null)).toBe("none");
    expect(setupView(check({ failed: true }), null)).toBe("none");
  });

  it("goes on to Start once an agent installed here is ready, before the PC is read again", () => {
    expect(setupView(check({ catalog: answer() }), "claude")).toBe("found");
    expect(setupView(check({ checking: true }), "claude")).toBe("found");
    const agents = startAgents(answer(installed("codex")), "claude");
    expect(agents.map((agent) => agent.id)).toEqual(["claude", "codex"]);
    // once the PC answers again it is there with its version, and listed once
    expect(startAgents(answer(installed("claude", "2.1.311")), "claude").map((agent) => `${agent.id}@${agent.state.version}`)).toEqual(["claude@2.1.311"]);
    expect(startAgents(null, null)).toEqual([]);
  });

  it("picks Claude Code, else Codex, else the first found, and the agent just set up over all", () => {
    expect(preferredAgent(foundAgents(answer(installed("codex"), installed("claude"), installed("pi"))), null)?.id).toBe("claude");
    expect(preferredAgent(foundAgents(answer(installed("pi"), installed("codex"))), null)?.id).toBe("codex");
    expect(preferredAgent(foundAgents(answer(installed("pi"), installed("omo"))), null)?.id).toBe("omo");
    expect(preferredAgent(foundAgents(answer(installed("claude"), installed("codex"))), "codex")?.id).toBe("codex");
    expect(preferredAgent([], null)).toBeNull();
  });

  it("turns plan usage on for accounts already signed in, and not for one to sign in again", () => {
    const account = (key: string, problem: ProviderUsage["problem"]): ProviderUsage => ({ id: "claude", key, account: null, plan: null, windows: [], problem, checked_at: null });
    expect(signedInAccounts([])).toBe(0);
    expect(signedInAccounts([account("a", null), account("b", "rate_limited")])).toBe(2);
    expect(signedInAccounts([account("a", "expired")])).toBe(0);
  });

  it("keeps an instant answer on screen briefly, and adds nothing to a slow check", () => {
    expect(settleDelay(1000, 1000)).toBe(CHECK_SETTLE_MS);
    expect(settleDelay(1000, 1000 + CHECK_SETTLE_MS - 100)).toBe(100);
    expect(settleDelay(1000, 1000 + CHECK_SETTLE_MS)).toBe(0);
    expect(settleDelay(1000, 3000)).toBe(0);
  });

  it("says for each agent whether it is still being looked for, there, or not", () => {
    expect(checkStatus(undefined)).toEqual({ kind: "looking" });
    expect(checkStatus(installed("claude", "2.1.311"))).toEqual({ kind: "installed", version: "2.1.311" });
    expect(checkStatus(installed("claude", null))).toEqual({ kind: "installed", version: null });
    expect(checkStatus(row("claude"))).toEqual({ kind: "missing" });
    expect(checkStatus(row("claude", { installed: null }))).toEqual({ kind: "unknown" });
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

describe("readSignedIn", () => {
  /** a scheduler the test runs by hand: each retry waits here until \`run()\`, or is cancelled */
  const scheduler = () => {
    const waiting: (() => void)[] = [];
    let cancelled = 0;
    return { waiting, cancelled: () => cancelled, schedule: (run: () => void) => { waiting.push(run); return () => { cancelled += 1; }; } };
  };
  const settled = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

  it("tries a failed read again, and reports the count once one answers", async () => {
    const answers = [Promise.reject(new Error("offline")), Promise.resolve(2)];
    const found: number[] = [];
    const timer = scheduler();
    readSignedIn(() => answers.shift()!, (count) => found.push(count), timer.schedule);
    await settled();
    expect(timer.waiting.length).toBe(1);
    timer.waiting.shift()!();
    await settled();
    expect(found).toEqual([2]);
  });

  it("stops when cancelled: no retry runs and a late answer changes nothing", async () => {
    let reads = 0;
    const found: number[] = [];
    const timer = scheduler();
    const late = Promise.withResolvers<number>();
    const cancel = readSignedIn(() => { reads += 1; return reads === 1 ? Promise.reject(new Error("offline")) : late.promise; }, (count) => found.push(count), timer.schedule);
    await settled();
    // the guide closed while the retry waited
    cancel();
    expect(timer.cancelled()).toBe(1);
    expect(reads).toBe(1);

    // and an answer already on its way when the guide closed is dropped too
    const second = scheduler();
    const stop = readSignedIn(() => late.promise, (count) => found.push(count), second.schedule);
    stop();
    late.resolve(3);
    await settled();
    expect(found).toEqual([]);
  });
});
