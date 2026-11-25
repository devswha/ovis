import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CONTRACT, isRecord, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { lineCall } from "../line-call.ts";
import * as herdr from "../herdr/client.ts";
import { AcpChildren } from "../acp/children.ts";
import { KEEPER_BUILD, keeperBuilt } from "../acp/keeper.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { AgentToolHub } from "./hub.ts";
import { procLink, stillIn, type PaneTerminal } from "./pane-proof.ts";

const CLI = join(import.meta.dir, "../../scripts/plugin-agent.ts");
const START: HarnessToolSetting = { level: "start", depth: 1, harnesses: ["opencode"] };
let state: string, hub: AgentToolHub, setting: HarnessToolSetting, terminals: PaneTerminal[];
let snapshot: ReturnType<typeof spyOn>;

function paneHub() {
  return new AgentToolHub({ dir: join(state, "agent-tools"), setting: () => setting, acp: new AcpChildren(join(state, "acp")),
    panes: { list: async () => terminals, get: async address => terminals.find(t => t.address === address) ?? null } });
}

const paneRegistry = () => join(state, "agent-tools", "pane-runs.json");
function paneRuns() {
  const rows: unknown = JSON.parse(readFileSync(paneRegistry(), "utf8"));
  if (!Array.isArray(rows)) throw new Error("missing pane runs");
  return rows.map((row: unknown) => {
    if (!isRecord(row) || !isRecord(row.run) || typeof row.run.id !== "string" || typeof row.run.self !== "string" || !Array.isArray(row.calls)) throw new Error("invalid pane run");
    return { id: row.run.id, self: row.run.self, calls: row.calls.length };
  });
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "athp-"));
  setting = START;
  terminals = [];
  hub = paneHub();
  hub.listen();
  snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ protocol: 22, version: "fixture", agents: [], workspaces: [], tabs: [], layouts: [], panes: [] });
});
afterEach(() => { snapshot.mockRestore(); hub.close(); rmSync(state, { recursive: true, force: true }); });

const callerEnv = (hint?: string) => {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: state, OVIS_STATE_DIR: state };
  if (hint) env["HC_TERMINAL_ID"] = hint;
  return env;
};
const callerArgv = (words: readonly string[]) => [process.execPath, "-e", `const { runAgent } = await import(${JSON.stringify(CLI)}); process.exit(await runAgent(${JSON.stringify(words)}));`];

/** A pane: a shell hc would run, whose pid is the pane's root, that starts the command once it is told the pane exists. */
async function inPane(address: string, words: readonly string[], options: { hint?: string; raw?: boolean } = {}) {
  const command = options.raw ? words : callerArgv(words);
  const shell = Bun.spawn(["/bin/sh", "-c", 'read go; "$@"; status=$?; exit $status', "pane", ...command], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: callerEnv(options.hint) });
  terminals = [...terminals.filter(t => t.address !== address), { address, state: "live", pid: shell.pid, created_ms: shell.pid, labels: {}, name: `pane ${address}` }];
  shell.stdin.write("go\n"); await shell.stdin.end();
  const lines = (await new Response(shell.stdout).text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  return { code: await shell.exited, reply: lines[0]!, lines };
}
async function outside(words: readonly string[]) {
  const caller = Bun.spawn(callerArgv(words), { stdout: "pipe", stderr: "inherit", env: callerEnv() });
  return { code: await caller.exited, reply: JSON.parse(await new Response(caller.stdout).text()) as Record<string, unknown> };
}
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const code = (reply: Record<string, unknown>) => (reply["error"] as { code?: string } | undefined)?.code;

describe.skipIf(process.platform !== "linux")("ovis agent from a pane hc started", () => {
  it("accepts concurrent first calls from one proven pane without asking for consent", async () => {
    const shell = await holdPane("t7");
    try {
      const line = callerArgv(["ls", "--json"]).map(quote).join(" ");
      expect((await shell.run(`${line} & ${line}; wait`, 2)).map(reply => reply.kind)).toEqual(["sessions", "sessions"]);
    } finally { await shell.close(); }
  });

  it.skipIf(!keeperBuilt)("starts work on the first call from a proven pane and only asks a person for the child's own approval", async () => {
    hub.close();
    serveRuntime(HERDR_CORE);
    const program = join(state, "agy");
    const replay = join(import.meta.dir, "replay-agent.fake.ts");
    const recording = join(import.meta.dir, "fixtures/agy-1.5.16-ask-write.jsonl");
    writeFileSync(program, `#!/bin/sh\n[ "$1" = --version ] && { echo 1.5.16; exit; }\nexec ${quote(process.execPath)} ${quote(replay)} ${quote(recording)} ${quote(join(state, "replay.jsonl"))}\n`);
    chmodSync(program, 0o755);
    const programs: ReturnType<typeof Bun.spawn>[] = [];
    const fake = new FakeHcCore();
    fake.onStart = started => { programs.push(Bun.spawn([...started.argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: callerEnv() })); };
    const hc = new HcConnection(() => fake.transport());
    const acp = new AcpChildren(join(state, "acp"), { hc, keeperBin: () => KEEPER_BUILD });
    setting = { ...START, harnesses: ["agy"] };
    hub = new AgentToolHub({ dir: join(state, "agent-tools"), acp, setting: () => setting, resolve: () => ({ argv: [program] }),
      panes: { list: async () => terminals, get: async address => terminals.find(t => t.address === address) ?? null } });
    hub.listen();
    const shell = await holdPane("t7");
    try {
      const started = await shell.call(["start", "--harness", "agy", "--cwd", state, "--task", "write a file", "--json"]);
      expect(started).toMatchObject({ kind: "session", sent: { accepted: true } });
      const session = started.session;
      if (!session || typeof session !== "object" || !("address" in session) || typeof session.address !== "string") throw new Error("missing child address");
      expect(await shell.call(["wait", session.address, "--timeout-s", "5", "--json"])).toMatchObject({ state: { state: "waiting_human" } });
      expect(acp.forPane(session.address)?.client.pending()).toHaveLength(1);
    } finally {
      await shell.close();
      acp.close();
      for (const proc of programs) { proc.kill(); await proc.exited; }
      hc.close();
      serveRuntime(null);
    }
  });

  it("shares one pane run and its call count across processes and an Ovis restart", async () => {
    const shell = await holdPane("t7", "t7");
    try {
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      const [first] = paneRuns();
      if (!first) throw new Error("missing first pane run");
      hub.close();
      hub = paneHub();
      await hub.reconcilePanes();
      hub.listen();
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      expect(paneRuns()).toEqual([{ id: first.id, self: "t7", calls: 2 }]);
    } finally { await shell.close(); }
  });

  it("refuses tokenless calls in a pane Ovis already manages", async () => {
    hub.runs.reserve().bind({ self: "t7", root: "0123456789abcdef", depth: 0, started_by: null, harness: "omo" });
    expect(code((await inPane("t7", ["ls", "--json"])).reply)).toBe("not_granted");
  });

  it("ends every pane run when switching to look-only even if the registry write fails", async () => {
    const first = await holdPane("t7"), second = await holdPane("t8");
    try {
      for (const shell of [first, second]) expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      const previous = paneRuns().map(row => row.id);
      rmSync(paneRegistry());
      mkdirSync(paneRegistry());
      setting = { ...START, level: "view" };
      expect(() => hub.settingsChanged()).toThrow();
      rmSync(paneRegistry(), { recursive: true });
      setting = START;
      hub.settingsChanged();
      for (const shell of [first, second]) expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      expect(paneRuns().filter(row => previous.includes(row.id))).toEqual([]);
    } finally { await first.close(); await second.close(); }
  });

  it("a pane registry that cannot be written does not stop a token run", async () => {
    const key = hub.runs.reserve();
    key.bind({ self: "t1", root: key.id, started_by: null, depth: 0, harness: "omo" });
    mkdirSync(join(state, "agent-tools", "pane-runs.json"));
    const reply = await lineCall(hub.address, { id: 1, contract: HARNESS_CONTRACT, token: readFileSync(key.tokenFile, "utf8"), verb: "scope", args: {} }, 2000);
    expect(reply).toMatchObject({ kind: "scope" });
  });

  it("refuses a process outside every pane", async () => {
    terminals = [{ address: "t7", state: "live", pid: 999_999_999, created_ms: 1, labels: {} }];
    const reply = await outside(["ls", "--json"]);
    expect(reply.code).toBe(1);
    expect(code(reply.reply)).toBe("not_granted");
  });

  it("refuses another pane's process that claims to be pane X, and never grants it X's run", async () => {
    const shell = await holdPane("t7");
    try {
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      const posing = await inPane("t9", ["ls", "--json"], { hint: "t7" });
      expect(code(posing.reply)).toBe("not_granted");
      expect(paneRuns()).toEqual([expect.objectContaining({ self: "t7", calls: 1 })]);
      expect((await inPane("t9", ["ls", "--json"])).reply).toMatchObject({ kind: "sessions" });
    } finally { await shell.close(); }
  });

  it("ends a closed pane's run and starts a new one at the same address", async () => {
    const shell = await holdPane("t7");
    let previous: string | undefined;
    try {
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      previous = paneRuns()[0]?.id;
    } finally { await shell.close(); }
    terminals = [];
    await hub.reconcilePanes();
    expect(paneRuns()).toEqual([]);
    expect((await inPane("t7", ["ls", "--json"])).reply).toMatchObject({ kind: "sessions" });
    expect(paneRuns()[0]?.id).not.toBe(previous);
  });

  it("ends the old run when hc reports a different root for a pane that is still open", async () => {
    const previous = await holdPane("t7");
    try {
      expect(await previous.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      const prior = terminals.find(t => t.address === "t7");
      const replacement = await holdPane("t7");
      try {
        terminals = terminals.map(t => t.address === "t7" && prior ? { ...t, created_ms: prior.created_ms } : t);
        await hub.reconcilePanes();
        expect(paneRuns()).toEqual([]);
        expect(code(await previous.call(["ls", "--json"]))).toBe("not_granted");
        expect(await replacement.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      } finally { await replacement.close(); }
    } finally { await previous.close(); }
  });

  it.each([["view", "not_granted"], ["off", "tools_off"]] as const)("refuses a proved pane and ends its run at %s", async (level, reason) => {
    const shell = await holdPane("t7");
    try {
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      setting = { ...START, level };
      hub.settingsChanged();
      expect(code(await shell.call(["ls", "--json"]))).toBe(reason);
      expect(paneRuns()).toEqual([]);
    } finally { await shell.close(); }
  });

  it("keeps the hub's limits: an unticked harness is not started for a pane", async () => {
    const shell = await holdPane("t7");
    try {
      expect(code(await shell.call(["start", "--harness", "gjc", "--json"]))).toBe("not_granted");
    } finally { await shell.close(); }
  });

  it("still refuses starts on other machines for a proved local pane", async () => {
    const reply = await inPane("t7", ["start", "--harness", "opencode", "--on", "other", "--json"]);
    expect(reply.reply).toMatchObject({ error: { code: "approval_required", message: expect.stringContaining("another machine") } });
  });
});

/** A pane whose shell stays, running each command it is given as its own child, as a person types into it. */
async function holdPane(address: string, hint?: string) {
  const shell = Bun.spawn(["/bin/sh", "-c", 'while read -r line; do eval "$line"; done'], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: callerEnv(hint) });
  terminals = [...terminals.filter(t => t.address !== address), { address, state: "live", pid: shell.pid, created_ms: shell.pid, labels: {}, name: `pane ${address}` }];
  const reader = shell.stdout.getReader();
  let buffered = "";
  const line = async () => {
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at >= 0) { const out = buffered.slice(0, at); buffered = buffered.slice(at + 1); return out; }
      const { value, done } = await reader.read();
      if (done) throw new Error("pane shell ended");
      buffered += new TextDecoder().decode(value);
    }
  };
  const run = async (text: string, count: number) => {
    shell.stdin.write(`${text}\n`);
    await shell.stdin.flush();
    const out: Record<string, unknown>[] = [];
    while (out.length < count) out.push(JSON.parse(await line()) as Record<string, unknown>);
    return out;
  };
  return {
    run,
    call: async (words: readonly string[]) => (await run(callerArgv(words).map(quote).join(" "), 1))[0]!,
    close: async () => { await shell.stdin.end(); await shell.exited; },
  };
}
describe.skipIf(process.platform !== "linux")("a call's caller stays a process of its pane", () => {
  it("is in the pane while the pane's root, born when proved, is among its parents, and out once it is not", () => {
    const parent = procLink(process.ppid)!;
    const peer = { pid: process.pid, alive: () => true, close: () => {} };
    expect(stillIn(peer, { pane: "t1", created_ms: 1, root: parent.pid, birth: parent.birth })).toBe(true);
    expect(stillIn(peer, { pane: "t1", created_ms: 1, root: parent.pid, birth: "another-birth" })).toBe(false);
    expect(stillIn({ ...peer, alive: () => false }, { pane: "t1", created_ms: 1, root: parent.pid, birth: parent.birth })).toBe(false);
  });
});
