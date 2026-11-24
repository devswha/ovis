import { chmodSync, lstatSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { HubConnections } from "./connections.ts";
import { HARNESS_CONTRACT, HARNESS_LIMITS, TOOL_SCHEMAS, VIEW_VERBS, answer, harnessVerb, isRecord, isView, refuse, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { projectSafeCommand } from "../entries.ts";
import { coreConnection } from "../herdr-core/runtime.ts";
import { AcpStartFailed, type AcpChildren } from "../acp/children.ts";
import { KeeperRequestError } from "../acp/client.ts";
import { resolveHarness, type HarnessCommand } from "./harnesses.ts";
import { RunStore, type Run } from "./runs.ts";
import { Ledger, type ToolChild } from "./ledger.ts";
import { validArgs } from "./guards.ts";
import { ChildTurns, childRef, childState } from "./turns.ts";
import { HarnessView, type ViewOptions } from "./view.ts";

interface Options extends ViewOptions {
  readonly acp: AcpChildren;
  readonly dir: string;
  readonly setting: () => HarnessToolSetting;
  readonly now?: () => number;
  readonly resolve?: (kind: string) => HarnessCommand | null;
}
export class AgentToolHub {
  readonly address: string;
  readonly runs: RunStore;
  private server: Server | null = null;
  private readonly connections = new HubConnections();
  private readonly ledger: Ledger;
  private readonly turns: ChildTurns;
  private readonly view: HarnessView;
  private readonly now: () => number;
  private readonly waits = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly off: () => void;
  private closed = false;
  constructor(private readonly options: Options) {
    this.address = join(options.dir, "hub.sock");
    this.runs = new RunStore(options.dir);
    this.now = options.now ?? Date.now;
    this.ledger = new Ledger(options.dir);
    this.turns = new ChildTurns(this.ledger, options.acp, this.now);
    this.view = new HarnessView(options, options.acp, this.ledger);
    this.off = options.acp.onStatus(child => {
      const row = this.ledger.children.get(child.terminal);
      if (row?.id === child.id && (child.client.keeperGone || child.client.agentGone)) {
        this.runs.revoke(row.run);
        if (child.client.keeperGone) { this.turns.forget(child); return; }
      }
      this.turns.watch(child);
    });
    this.settingsChanged();
  }
  get setting() { return this.options.setting(); }
  private verbs(depth: number): readonly string[] {
    const policy = this.setting;
    return policy.level === "off" ? [] : policy.level === "start" && depth < policy.depth ? Object.keys(TOOL_SCHEMAS) : VIEW_VERBS;
  }
  async reconcileLaunches() {
    const terminals = await this.options.acp.terminals();
    const found = new Set<string>();
    for (const terminal of terminals) {
      const run = terminal.labels["ovis.run"];
      if (!run || terminal.state !== "live" || terminal.address.includes("/")) continue;
      const child = this.options.acp.forPane(terminal.address);
      if (found.has(run) || !child || child.id !== terminal.labels["ovis.acp"]) throw new Error("Unreconciled agent keeper.");
      found.add(run);
      const saved = this.ledger.children.get(terminal.address);
      if (saved?.id === child.id && saved.run === run) continue;
      const intent = this.ledger.launches.get(run);
      if (!intent || intent.parent !== terminal.parent || intent.harness !== child.harness) throw new Error("Unverified keeper ownership.");
      const row: ToolChild = { ...intent, id: child.id, terminal: terminal.address, held: false, turns: [] };
      this.ledger.children.set(row.terminal, row); this.ledger.save(); this.ledger.audit(row, "start", null);
    }
    for (const key of this.ledger.launches.keys()) this.ledger.finish(key);
    return terminals;
  }
  settingsChanged(): void { if (this.setting.level === "off") this.runs.revokeAll(); }
  listen(): void {
    if (this.server) return;
    if (process.platform === "win32" || Buffer.byteLength(this.address) > 100) throw new Error("Agent tool socket is not available at this path.");
    const existing = lstatSync(this.address, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error("Agent tool socket path is occupied.");
      rmSync(this.address);
    }
    const server = createServer(s => this.connections.receive(s, (body, signal) => this.call(body, signal)));
    server.on("error", () => console.warn("Agent tool socket unavailable."));
    const mask = process.umask(0o077);
    try { server.listen(this.address); chmodSync(this.address, 0o600); this.server = server; }
    finally { process.umask(mask); }
  }
  close(): void { this.closed = true; this.off(); this.connections.close(); this.turns.close(); this.server?.close(); this.server = null; }
  command(tokenFile: string) {
    const [command, ...args] = projectSafeCommand("agent-mcp");
    if (!command) throw new Error("Missing relay command.");
    return { name: "ovis-agent", command, args: [...args, "--socket", this.address, "--token-file", tokenFile], env: [] };
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(id) ?? Promise.resolve();
    const next = prior.then(action, action);
    this.tails.set(id, next);
    try { return await next; } finally { if (this.tails.get(id) === next) this.tails.delete(id); }
  }
  private async call(input: unknown, signal: AbortSignal): Promise<object> {
    if (!isRecord(input) || input.contract !== HARNESS_CONTRACT) return refuse("unknown_contract", "Unknown contract.");
    const { token, verb, args } = input;
    const auth = () => !signal.aborted && !this.closed && this.setting.level !== "off" && typeof token === "string" ? this.runs.verify(token) : null;
    const deny = () => this.setting.level === "off" ? refuse("tools_off", "Agent tools are off.") : refuse("not_granted", "This run is not granted that operation.");
    const began = this.now();
    const run = auth();
    if (!run && verb === "scope" && !this.closed && this.setting.level !== "off" && typeof token === "string") {
      const depth = this.runs.discoveryDepth(token);
      if (depth !== undefined) return answer("scope", { verbs: this.verbs(depth) });
    }
    if (!run) return deny();
    if (!this.runs.takeCall(run.id, this.now())) return refuse("rate_limited", "Too many calls in the past minute.");
    if (verb === "scope") return answer("scope", { verbs: this.verbs(run.depth) });
    if (!harnessVerb(verb)) return refuse("bad_request", "Unknown verb.");
    if (!isView(verb) && this.setting.level !== "start") return deny();
    if (!validArgs(verb, args)) return refuse("bad_request", "Invalid or unexpected argument.");
    const privilegedRead = verb === "read" && (args.what === "result" || args.what === "screen");
    if (privilegedRead && !this.verbs(run.depth).includes("result")) return deny();
    if (isView(verb)) {
      const result = await this.view.query(verb, args, this.turns);
      return auth() && (!privilegedRead || this.verbs(run.depth).includes("result")) ? result : deny();
    }
    const allowed = () => !!auth() && this.verbs(run.depth).includes(verb);
    const session = String(args.session ?? "");
    if (verb === "start" || verb === "ask") {
      if (!allowed()) return refuse("depth_exceeded", "This run is at its depth limit.");
      const started = await this.serial(run.id, async () => {
        if (!allowed()) return deny();
        return this.start(run, args, allowed);
      });
      if (verb === "start" || !("session" in started) || started.kind !== "session") return started;
      const ref = started.session;
      const remaining = Math.max(0, HARNESS_LIMITS.wait_seconds - (this.now() - began) / 1000);
      const turnId = started.sent?.turn_id;
      const waiting = await this.wait(run, ref.address, { ...args, turn: turnId, timeout_s: Math.min(Number(args.timeout_s ?? 30), remaining) }, signal);
      if (!allowed()) return deny();
      if (!("state" in waiting)) return waiting;
      const child = this.options.acp.forPane(ref.address), row = this.ledger.children.get(ref.address);
      const result = child && row && waiting.state.state === "done" ? this.turns.result(child, row, turnId) : null;
      const payload = result?.kind === "result" ? (({ contract: _contract, kind: _kind, session: _session, ...body }) => body)(result) : null;
      return answer("ask", { session: ref, state: waiting.state, sent: started.sent, result: payload });
    }
    if (session === run.self) return refuse("self_target", "A run cannot target itself.");
    if (this.runs.ancestors(run).includes(session)) return refuse("ancestor_target", "A run cannot target an ancestor.");
    if (!allowed()) return deny();
    const row = this.ledger.children.get(session);
    if (!row) return refuse("unknown_session", "Unknown session.");
    if (row.starter !== run.id) return refuse("not_owner", "Not your child.");
    const child = this.options.acp.forPane(session);
    if (!child || child.id !== row.id) return refuse("unknown_session", "The child has ended.");
    await child.client.ready(signal);
    if (!allowed()) return deny();
    this.turns.watch(child);
    if (verb === "result") return this.turns.result(child, row, args.turn);
    if (verb === "wait") {
      const result = await this.wait(run, session, args, signal);
      return allowed() ? result : deny();
    }
    return this.serial(run.id, async () => {
      if (!allowed()) return deny();
      if (this.options.acp.forPane(session) !== child) return refuse("unknown_session", "The child has ended.");
      if (verb === "send") return this.turns.send(child, row, args);
      if (row.held || child.client.terminalReady) return refuse("taken_over", "A person holds this session.");
      try {
        const receipt = await child.client.request("_keeper/tool_stop", {}, signal);
        if (!isRecord(receipt) || receipt.stopping !== true) return refuse("unavailable", "Keeper did not confirm stop.");
      } catch (error) {
        if (error instanceof KeeperRequestError && error.code === -32003) return refuse("waiting_human", "A person must answer the child's card.");
        if (error instanceof KeeperRequestError && error.code === -32002) return refuse("taken_over", "A person holds this child.");
        throw error;
      }
      await this.options.acp.stop(row.id);
      this.ledger.audit(row, "stop", null);
      this.turns.forget(child);
      this.ledger.children.delete(session); this.ledger.save(); this.runs.revoke(row.run);
      return answer("stopped", { session, stopped: true });
    });
  }
  private async wait(run: Run, session: string, args: Record<string, unknown>, signal: AbortSignal) {
    const row = this.ledger.children.get(session), child = this.options.acp.forPane(session);
    if (!row || !child || row.id !== child.id) return refuse("unknown_session", "The child has ended.");
    if (args.turn && args.turn !== `${row.id}.${row.turns.at(-1)?.n}`) {
      const old = row.turns.find(t => `${row.id}.${t.n}` === args.turn);
      return old?.end ? answer("state", { session, state: { state: "done", turn: old.n } }) : refuse("unknown_session", "Unknown turn.");
    }
    const n = this.waits.get(run.id) ?? 0;
    if (n >= 8) return refuse("rate_limited", "Too many open waits.");
    this.waits.set(run.id, n + 1);
    try { return await this.turns.wait(child, row, Number(args.timeout_s ?? 30) * 1000, signal); }
    finally { this.waits.set(run.id, (this.waits.get(run.id) ?? 1) - 1); }
  }
  private async start(run: Run, args: Record<string, unknown>, allowed: () => boolean) {
    const kind = String(args.harness);
    if (args.on !== undefined && args.on !== "local") return refuse("approval_required", "Starting on another machine needs a person's approval and is not supported yet.");
    if (!this.setting.harnesses.includes(kind)) return refuse("not_granted", "This harness was not enabled.");
    if (run.depth >= this.setting.depth) return refuse("depth_exceeded", "This run is at its depth limit.");
    const own = [...this.ledger.children.values()].filter(r => r.starter === run.id && this.options.acp.forPane(r.terminal)?.id === r.id);
    const used = typeof args.key === "string" ? this.runs.previousStart(run.id, args.key) : undefined;
    if (used) {
      const row = own.find(r => r.run === used), child = row ? this.options.acp.forPane(row.terminal) : null;
      if (row && child) return answer("session", { session: childRef(row, child), state: childState(child, row), sent: row.turns[0] ? { accepted: true, turn_id: `${row.id}.${row.turns[0].n}`, key: args.key, duplicate: true } : null });
      return refuse("unknown_session", "This key named a child that is no longer available.");
    }
    if (own.length + [...this.ledger.launches.values()].filter(i => i.starter === run.id).length >= HARNESS_LIMITS.children) return refuse("children_limit", "Four child slots are in use.");
    const launch = (this.options.resolve ?? resolveHarness)(kind);
    if (!launch) return refuse("start_failed", "This harness has no supported ACP adapter.");
    const cwd = typeof args.cwd === "string" ? args.cwd : (await coreConnection().call("terminal.get", { terminal: run.self })).cwd;
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return refuse("bad_request", "The folder does not exist.");
    if (!allowed() || !this.setting.harnesses.includes(kind) || run.depth >= this.setting.depth) return refuse("not_granted", "The grant changed.");
    const key = this.runs.reserve(run.depth + 1);
    const intent = { run: key.id, parent: run.self, starter: run.id, harness: kind, created: this.now() };
    try {
      if (typeof args.key === "string") this.runs.rememberStart(run.id, args.key, key.id);
      this.ledger.begin(intent);
      const child = await this.options.acp.start({ harness: kind, argv: launch.argv, env: { ...launch.env, OVIS_AGENT_SOCKET: this.address, OVIS_AGENT_TOKEN_FILE: key.tokenFile },
        cwd, parentPane: run.self, runId: key.id, mcpServers: [this.command(key.tokenFile)] });
      this.view.signInNeeded.delete(kind);
      const row: ToolChild = { id: child.id, terminal: child.terminal, harness: kind, starter: run.id, parent: run.self, run: key.id, created: this.now(), held: false, turns: [] };
      this.ledger.children.set(child.terminal, row); this.ledger.save(); this.ledger.audit(row, "start", null); this.turns.watch(child);
      this.ledger.finish(key.id);
      if (!allowed() || !this.setting.harnesses.includes(kind) || run.depth >= this.setting.depth) { key.cancel(); return refuse("not_granted", "The grant changed while starting."); }
      key.bind({ self: child.terminal, depth: run.depth + 1, root: run.root, harness: kind, started_by: run.id });
      const accepted = args.task ? await this.turns.send(child, row, args) : null;
      if (accepted?.kind === "refusal") return accepted;
      const sent = accepted ? { accepted: true, turn_id: accepted.turn_id, key: accepted.key, duplicate: accepted.duplicate } : null;
      return answer("session", { session: childRef(row, child), state: childState(child, row), sent });
    } catch (error) {
      if (error instanceof AcpStartFailed && error.agentCode === -32000) this.view.signInNeeded.add(kind);
      const live = await this.options.acp.terminals().catch(() => null);
      if (live && !live.some(t => t.state === "live" && t.labels["ovis.run"] === key.id)) this.ledger.finish(key.id);
      key.cancel(); return refuse("start_failed", "The harness did not open an ACP session.");
    }
  }
}
