import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinesOf, notConnected, onMainSteps, pullMainSteps, rollOut, settingOf, withSetting } from "./deploy-helpers.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** `git` in `cwd` with no user or system config, as nobody in particular; stdout trimmed. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A checkout of an origin whose main has moved on one commit since the checkout was cloned. */
function checkoutBehindOrigin(): { checkout: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "deploy-pull-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  git(seed, "commit", "-q", "--allow-empty", "-m", "first");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", origin, checkout);
  git(seed, "commit", "-q", "--allow-empty", "-m", "second");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { checkout, origin };
}

const runSteps = (checkout: string) => spawnSync("sh", ["-c", pullMainSteps(checkout).join(" && ")], { encoding: "utf8" });

describe("the steps that bring the VPS checkout to origin/main", () => {
  it("fast-forwards a checkout that is on main", () => {
    const { checkout, origin } = checkoutBehindOrigin();
    expect(runSteps(checkout).status).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "main"));
  });

  it("stops before changing anything on a branch under test, whether it is ahead of main or not", () => {
    const { checkout, origin } = checkoutBehindOrigin();
    git(checkout, "switch", "-q", "-c", "feat/under-test");
    for (const ahead of [false, true]) {
      if (ahead) git(checkout, "commit", "-q", "--allow-empty", "-m", "the branch's own work");
      const before = git(checkout, "rev-parse", "HEAD");
      const result = runSteps(checkout);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("'feat/under-test', not main");
      expect(git(checkout, "branch", "--show-current")).toBe("feat/under-test");
      expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
      expect(git(checkout, "rev-parse", "main")).not.toBe(git(origin, "rev-parse", "main"));
    }
  });

  it("stops on a detached HEAD too", () => {
    const { checkout } = checkoutBehindOrigin();
    git(checkout, "checkout", "-q", "--detach");
    const result = runSteps(checkout);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not main");
  });
});

describe("the check that a run on the VPS itself starts from main", () => {
  const runGuard = (checkout: string) => spawnSync("sh", ["-c", onMainSteps(checkout).join(" && ")], { encoding: "utf8" });

  it("passes a checkout on main without pulling it", () => {
    const { checkout, origin } = checkoutBehindOrigin();
    const before = git(checkout, "rev-parse", "HEAD");
    expect(runGuard(checkout).status).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
    expect(before).not.toBe(git(origin, "rev-parse", "main"));
  });

  it("stops on a branch under test and on a detached HEAD, before anything is built or restarted", () => {
    const { checkout } = checkoutBehindOrigin();
    git(checkout, "switch", "-q", "-c", "feat/under-test");
    const onBranch = runGuard(checkout);
    expect(onBranch.status).not.toBe(0);
    expect(onBranch.stderr).toContain("'feat/under-test', not main");
    expect(onBranch.stderr).toContain("nothing was changed");
    git(checkout, "checkout", "-q", "--detach");
    expect(runGuard(checkout).status).not.toBe(0);
  });
});

describe("a plugin settings file with one setting set", () => {
  it("adds the setting after the others, on a line of its own", () => {
    expect(withSetting("A=1\nB=2\n", "OVIS_AUTO_UPDATE", "1")).toBe("A=1\nB=2\nOVIS_AUTO_UPDATE=1\n");
    expect(withSetting("A=1\nB=2", "OVIS_AUTO_UPDATE", "1")).toBe("A=1\nB=2\nOVIS_AUTO_UPDATE=1\n");
    expect(withSetting("", "OVIS_AUTO_UPDATE", "1")).toBe("OVIS_AUTO_UPDATE=1\n");
  });

  it("changes a setting that is there, and only that line", () => {
    expect(withSetting("A=1\nOVIS_AUTO_UPDATE=0\n# kept\nB=2\n", "OVIS_AUTO_UPDATE", "1")).toBe("A=1\nOVIS_AUTO_UPDATE=1\n# kept\nB=2\n");
    expect(withSetting("  OVIS_AUTO_UPDATE = \"0\"\n", "OVIS_AUTO_UPDATE", "1")).toBe("OVIS_AUTO_UPDATE=1\n");
  });

  it("changes every line that sets it, as the plugin reads the last one", () => {
    expect(withSetting("OVIS_AUTO_UPDATE=1\nA=1\nOVIS_AUTO_UPDATE=0\n", "OVIS_AUTO_UPDATE", "1")).toBe("OVIS_AUTO_UPDATE=1\nA=1\nOVIS_AUTO_UPDATE=1\n");
  });

  it("leaves a setting that is already right, and a commented one, alone", () => {
    const set = "A=1\nOVIS_AUTO_UPDATE=1\n";
    expect(withSetting(set, "OVIS_AUTO_UPDATE", "1")).toBe(set);
    expect(withSetting("# OVIS_AUTO_UPDATE=0\n", "OVIS_AUTO_UPDATE", "1")).toBe("# OVIS_AUTO_UPDATE=0\nOVIS_AUTO_UPDATE=1\n");
  });

  it("does not take another setting that starts with the same letters for it", () => {
    expect(withSetting("OVIS_AUTO_UPDATE_X=0\n", "OVIS_AUTO_UPDATE", "1")).toBe("OVIS_AUTO_UPDATE_X=0\nOVIS_AUTO_UPDATE=1\n");
  });
});

describe("settingOf", () => {
  it("gives the last value a line sets, unquoted, and null when none does", () => {
    expect(settingOf("PORT=1\n# PORT=2\n PORT = \"7400\"\n", "PORT")).toBe("7400");
    expect(settingOf("PORT_X=1\n", "PORT")).toBeNull();
    expect(settingOf("PORT=\n", "PORT")).toBeNull();
  });
});

describe("notConnected", () => {
  const machines = [{ id: "m1", name: "omarchy", state: "connected", error: null }, { id: "m2", name: "mini", state: "error", error: "still older than this app" }, { id: "m3", name: "other", state: "error", error: "x" }];
  const pc = (id: string, name: string) => ({ id, name });

  it("names each listed PC that is not connected, with its error, and ignores PCs not listed", () => {
    expect(notConnected(machines, [pc("m1", "omarchy"), pc("m2", "mini")])).toEqual(["mini (error: still older than this app)"]);
    expect(notConnected(machines, [pc("m1", "omarchy")])).toEqual([]);
  });

  it("counts a listed PC the server does not list at all as not connected", () => {
    expect(notConnected(machines, [pc("gone", "gone")])).toEqual(["gone (not listed)"]);
    expect(notConnected([{ id: "a", name: "a", state: "connecting", error: null }], [pc("a", "a")])).toEqual(["a (connecting)"]);
  });

  it("tells PCs with the same name apart by id", () => {
    const twins = [{ id: "m1", name: "PC", state: "connected", error: null }, { id: "m2", name: "PC", state: "error", error: "older" }];
    expect(notConnected(twins, [pc("m1", "PC"), pc("m2", "PC")])).toEqual(["PC (error: older)"]);
  });
});

describe("rollOut", () => {
  const pcA = { id: "a", name: "PC", kind: "ssh", state: "error", error: null, target: { destination: "a", own_ovis: "x" } };
  const pcB = { id: "b", name: "PC", kind: "ssh", state: "error", error: null, target: { destination: "b", own_ovis: "x" } };
  const local = { id: "l", name: "here", kind: "local", state: "connected", error: null };

  /** Steps that record what ran; `after` decides what /api/machines shows once the server restarted. */
  function steps(options: { after?: (call: number) => unknown[] | Promise<unknown[]>; updates?: Record<string, boolean> } = {}) {
    const trace: string[] = [];
    let restarted = false; let polls = 0;
    return {
      trace,
      steps: {
        listMachines: async (_signal: AbortSignal) => {
          if (!restarted) { trace.push("list"); return [local, pcA, pcB]; }
          trace.push("poll");
          return (await (options.after ?? (() => [local, { ...pcA, state: "connected" }, { ...pcB, state: "connected" }]))(polls++)) as typeof pcA[];
        },
        updatePc: (machine: { id: string }) => { trace.push(`update ${machine.id}`); return options.updates?.[machine.id] ?? true; },
        restart: () => { trace.push("restart"); restarted = true; },
        afterRestart: async () => { trace.push("after"); },
      },
    };
  }

  it("updates every PC before it restarts the server, then waits for them to connect", async () => {
    const run = steps();
    const result = await rollOut(run.steps, { connectMs: 500, pollMs: 1 });
    expect(run.trace).toEqual(["list", "update a", "update b", "restart", "after", "poll"]);
    expect(result.stale).toEqual([]);
    expect(result.waiting).toEqual([]);
    expect(result.pcs.map((pc) => pc.id)).toEqual(["a", "b"]);
  });

  it("keeps waiting while a PC is not connected, and reports it by id when the time is up", async () => {
    const run = steps({ after: () => [local, { ...pcA, state: "connected" }, { ...pcB, error: "older than this app" }] });
    const result = await rollOut(run.steps, { connectMs: 30, pollMs: 1 });
    expect(result.waiting).toEqual(["PC (error: older than this app)"]);
    expect(run.trace.filter((step) => step === "poll").length).toBeGreaterThan(1);
  });

  it("does not wait for a PC whose update failed, even when another PC has its name", async () => {
    const run = steps({ updates: { b: false }, after: () => [local, { ...pcA, state: "connected" }, { ...pcB, error: "old" }] });
    const result = await rollOut(run.steps, { connectMs: 30, pollMs: 1 });
    expect(result.stale.map((pc) => pc.id)).toEqual(["b"]);
    expect(result.waiting).toEqual([]);
  });

  it("fails at the deadline when /api/machines accepts a request and never answers", async () => {
    const run = steps();
    const hanging = { ...run.steps, listMachines: async (signal: AbortSignal) => {
      if (!run.trace.includes("restart")) return [local, pcA];
      return await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    } };
    const started = Date.now();
    const result = await rollOut(hanging, { connectMs: 60, pollMs: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.waiting).toEqual(["PC (not listed)"]);
  });

  it("stops before touching any PC when the server does not list them", async () => {
    const run = steps();
    await expect(rollOut({ ...run.steps, listMachines: async () => { throw new Error("refused"); } })).rejects.toThrow("refused");
    expect(run.trace).toEqual([]);
  });
});

describe("machinesOf", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("gives the roster of an answered /api/machines", async () => {
    const pc = { id: "a", name: "a", kind: "ssh", state: "connected", error: null };
    expect(await machinesOf(json({ machines: [pc] }))).toEqual([pc]);
    expect(await machinesOf(json({ machines: [] }))).toEqual([]);
  });

  it("refuses an error answer, such as the 401 an unauthenticated request gets, instead of reading it as no PCs", async () => {
    await expect(machinesOf(json({ error: "unauthorized" }, 401))).rejects.toThrow("401");
  });

  it("refuses an answer without a roster, or not JSON", async () => {
    await expect(machinesOf(json({}))).rejects.toThrow("roster");
    await expect(machinesOf(json({ machines: "x" }))).rejects.toThrow("roster");
    await expect(machinesOf(new Response("<html>", { status: 200 }))).rejects.toThrow("roster");
  });
});
