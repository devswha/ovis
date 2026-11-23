import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PanePlan } from "../shared/plans.ts";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { handlePlanRequest } from "./plan-routes.ts";
import { SessionPlans } from "./session-plan.ts";
import { omp } from "./session-plan.fixture.ts";

describe("GET /api/pane/plan", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
  const noPlan = async (response: Response) => {
    expect(response.status).toBe(200);
    const body = await response.json() as { plan: unknown; server_time: string };
    expect(body.plan).toBeNull();
    expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
  };

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-plan-route-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("wants GET and a pane", async () => {
    expect(await error(await fetch(url("/api/pane/plan?pane_id=w1:p1"), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
    expect(await error(await fetch(url("/api/pane/plan")))).toEqual([400, "missing_pane_id"]);
  });

  it("tells a pane herdr does not have, or one that keeps no plan, that it has none", async () => {
    const snapshot = {
      workspaces: [{ workspace_id: "w1", label: "app" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", number: 1 }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: stateDir, agent_status: "idle" }],
    } as unknown as SessionSnapshot;
    const snap = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => snapshot);
    try {
      await noPlan(await fetch(url("/api/pane/plan?pane_id=w9:p9")));
      await noPlan(await fetch(url("/api/pane/plan?pane_id=w1:p1")));
    } finally {
      snap.mockRestore();
    }
  });

  it("tells a pane it has no plan when herdr does not answer within its second", async () => {
    let answer: () => void = () => undefined;
    const snap = spyOn(herdr, "sessionSnapshot").mockImplementation(() => new Promise((_resolve, reject) => { answer = () => reject(new HerdrError("timeout", "herdr did not answer")); }));
    try {
      await noPlan(await fetch(url("/api/pane/plan?pane_id=w1:p1")));
    } finally {
      answer();
      snap.mockRestore();
    }
  });
});

describe("handlePlanRequest for an omp pane", () => {
  const address = "http://localhost/api/pane/plan?pane_id=w1:p1";
  const answer = 'Remaining items (2):\n  - Read [in_progress] (Build)\n  - Fix [pending] (Build)\nOverall: 0/2 done, 2 open.\nActive phase 1/1 "Build" (0/2).\n  Build:\n    - [ ] Read (in progress)\n    - [ ] Fix';
  const pane = { pane_id: "w1:p1", agent: "omp", cwd: "/w", agent_session: { kind: "path", value: "/s.jsonl" } } as unknown as HerdrPane;
  const ensured: string[] = [];
  const ask = async (plans: SessionPlans): Promise<PanePlan> => {
    const response = await handlePlanRequest(new Request(address), new URL(address), "/api/pane/plan", {
      omo: { apply: <T>(read: T): T => read },
      claudeAgents: { ensure: async (found) => { ensured.push(found.pane_id); } },
      plans,
    });
    expect(response?.status).toBe(200);
    return await response!.json() as PanePlan;
  };

  it("finds the transcript of a pane the last snapshot had not shown, and answers the plan as the poll last read it", async () => {
    const o = omp();
    o.todo(answer, 1);
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => null, ompPath: async () => o.path, onChange: () => {} });
    const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane] } as never);
    try {
      // nothing is read for a request: it only looks the transcript up
      expect((await ask(plans)).plan).toBeNull();
      expect(plans.known(pane)).toBe(true);
      plans.poll();
      const read = await ask(plans);
      expect(read.plan?.steps.map((step) => [step.label, step.status])).toEqual([["Read", "in_progress"], ["Fix", "pending"]]);
      expect(Number.isFinite(Date.parse(read.server_time))).toBe(true);
      // the Claude tracker is asked about a Claude pane only
      expect(ensured).toEqual([]);
    } finally {
      snapshot.mockRestore();
    }
  });

  it("answers no plan for a pane no transcript was found for, or one herdr does not list", async () => {
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => null, ompPath: async () => null, onChange: () => {} });
    const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane] } as never);
    try {
      expect((await ask(plans)).plan).toBeNull();
      expect(plans.known(pane)).toBe(false);
      snapshot.mockResolvedValue({ panes: [] } as never);
      expect((await ask(plans)).plan).toBeNull();
    } finally {
      snapshot.mockRestore();
    }
  });
});
