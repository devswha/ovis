import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MovePlan } from "../shared/runtime-move.ts";
import { paneSplit, sessionSnapshot, tabCreate, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { HcConnection, spawnHcConnect } from "./herdr-core/connection.ts";
import { planMove } from "./runtime-move.ts";
import { runMove } from "./runtime-move-run.ts";
import { coreDestination, herdrSource } from "./runtime-move-service.ts";

/**
 * A move of shells only, from the test herdr session to a real hc in a core of its own (its
 * session, state, config and runtime folders): built, then ended again when the switch is refused,
 * then built and kept when it is taken. Runs only where OVIS_TEST_HC_BIN names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];
const TEST_MS = 60_000;

describe.skipIf(!bin)("move of herdr's session to a real herdr-core", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mv-")));
  const stateDir = join(root, "ovis-state");
  let env: Record<string, string> = {};
  let hc: HcConnection | null = null;
  let workspace: string | null = null;
  const originalHcEnv = process.env["OVIS_HC_ENV"];
  const originalHcBin = process.env["OVIS_HC_BIN"];

  beforeAll(async () => {
    for (const sub of ["state", "config", "run", "ovis-state"]) mkdirSync(join(root, sub), { mode: 0o700 });
    env = {
      // short names: hc's socket path under a long TMPDIR must stay within the OS's limit (107 bytes)
      HC_SESSION: `mv${process.pid}`,
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_RUNTIME_DIR: join(root, "run"),
      HC_SOCKET: join(root, "run", "hc.sock"),
      OVIS_HC_BIN: bin!,
    };
    // the move reaches the core the server would once it serves herdr-core (runtime.ts hcEnv)
    process.env["OVIS_HC_ENV"] = JSON.stringify(env);
    // found as startRuntime finds it: in this process's environment
    process.env["OVIS_HC_BIN"] = bin!;
    const started = Bun.spawn([bin!, "server", "start"], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "pipe" });
    expect({ exit: await started.exited, stderr: await new Response(started.stderr).text() }).toMatchObject({ exit: 0 });
    hc = new HcConnection(() => spawnHcConnect(bin!, { ...process.env, ...env }));
  }, TEST_MS);

  afterAll(async () => {
    hc?.close();
    Bun.spawnSync([bin!, "server", "stop"], { env: { ...process.env, ...env } });
    if (workspace) await workspaceClose(workspace);
    if (originalHcEnv === undefined) delete process.env["OVIS_HC_ENV"]; else process.env["OVIS_HC_ENV"] = originalHcEnv;
    if (originalHcBin === undefined) delete process.env["OVIS_HC_BIN"]; else process.env["OVIS_HC_BIN"] = originalHcBin;
    rmSync(root, { recursive: true, force: true });
  });

  it("builds every workspace, tab and split on herdr-core, and ends all of it when the switch is refused", async () => {
    const left = join(root, "left");
    const right = join(root, "right");
    const logs = join(root, "logs");
    for (const dir of [left, right, logs]) mkdirSync(dir);
    const created = await workspaceCreate({ cwd: left, label: "moved" });
    workspace = created.workspace.workspace_id;
    const down = await paneSplit(created.root_pane.pane_id, "down", false);
    const tab = await tabCreate({ workspaceId: workspace, cwd: logs, label: "logs" });
    // the split's shell starts where the first pane is; its folder in the plan is the one asked of the move
    const full = await planMove(await sessionSnapshot(), { findResume: async () => null, processInfo: async () => undefined, inputEmpty: async () => null, holdsPending: () => false });
    const ours = new Set([created.root_pane.pane_id, down.pane_id, tab.root_pane.pane_id]);
    const plan: MovePlan = {
      ready: true,
      revision: full.revision,
      workspaces: full.workspaces.filter((entry) => entry.workspace_id === workspace),
      panes: full.panes.filter((pane) => ours.has(pane.pane_id)).map((pane) => ({ ...pane, cwd: pane.pane_id === down.pane_id ? right : pane.cwd, verdict: { kind: "shell" } })),
    };
    const moved = async (id: string) => (await hc!.call("terminal.list", { labels: { "ovis.move": id }, all: true })).terminals.filter((terminal) => terminal.state === "live");

    const refusedDestination = await coreDestination(stateDir, "refused-move");
    try {
      const journal = await runMove(stateDir, 7421, "refused-move", plan, herdrSource(() => false, async () => null), refusedDestination, { switchRuntime: () => "locked" });
      expect([journal.state, journal.reason]).toEqual(["rolled_back", "switch_refused: locked"]);
      expect(await moved("refused-move")).toEqual([]);
    } finally { refusedDestination.close(); }

    const destination = await coreDestination(stateDir, "kept-move");
    try {
      const journal = await runMove(stateDir, 7421, "kept-move", plan, herdrSource(() => false, async () => null), destination, { switchRuntime: () => null });
      expect(journal.state).toBe("committed");
    } finally { destination.close(); }
    const terminals = await moved("kept-move");
    expect(terminals.map((terminal) => terminal.cwd).sort()).toEqual([left, logs, right].sort());
    const labels = terminals.map((terminal) => terminal.labels ?? {});
    expect(new Set(labels.map((entry) => entry["herdr.space"])).size).toBe(1);
    expect(labels.map((entry) => entry["ovis.tab"] ?? "").sort()).toEqual(["1", "1", "logs"].sort());
    const layout = (await hc!.call("doc.get", { name: "ovis-layout" })).value as { workspaces: { tabs: { root: { split?: string } }[] }[] };
    expect(layout.workspaces[0]?.tabs[0]?.root.split).toBe("down");
    // herdr is left as it was: its panes are all still there
    expect((await sessionSnapshot()).panes.filter((pane) => ours.has(pane.pane_id))).toHaveLength(3);
  }, TEST_MS);
});
