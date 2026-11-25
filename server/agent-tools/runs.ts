import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeStateDocument } from "../state-document.ts";
import { HARNESS_LIMITS } from "../../shared/harness-tool.ts";
import { readProcessBirth } from "../process-owner.ts";
import { localPane, procLink, sameKey, type PaneKey, type PaneTerminal } from "./pane-proof.ts";

export interface Run {
  readonly id: string;
  readonly self: string;
  readonly depth: number;
  readonly started_by: string | null;
  readonly root: string;
  readonly harness: string;
  readonly created_ms: number;
  /** Server-verified permission contract, not a harness mode name. Absent for TUI launches. */
  readonly ceiling?: string;
}
interface RunState { readonly run: Run; readonly starts?: readonly { key: string; run: string }[]; readonly calls?: readonly number[] }
interface Saved extends RunState { readonly hash: string; readonly foreground?: { pid: number; birth: string } }
interface PaneSaved extends RunState { readonly key: PaneKey }
const idPattern = /^[a-f0-9]{16}$/;
const digest = (token: string) => createHash("sha256").update(token).digest();
export interface LiveToolTerminal {
  address: string; state: string; labels: Record<string, string>;
  foreground?: { pid?: number; argv: readonly string[] } | null;
  parent?: string | null;
}

export function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error("Agent tool state must be a directory owned by this user.");
  chmodSync(path, 0o700);
}

export function writePrivate(path: string, text: string): void {
  writeStateDocument(path, text, false);
}

function saved(value: unknown): value is Saved {
  return runState(value) && "hash" in value && typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash);
}
function paneSaved(value: unknown): value is PaneSaved {
  if (!runState(value) || !("key" in value)) return false;
  const key = value.key;
  return !!key && typeof key === "object" && "pane" in key && key.pane === value.run.self
    && "created_ms" in key && typeof key.created_ms === "number" && Number.isFinite(key.created_ms)
    && "root" in key && typeof key.root === "number" && Number.isInteger(key.root) && key.root > 0
    && "birth" in key && typeof key.birth === "string"
    && value.run.harness === "hc-pane" && value.run.depth === 0 && value.run.started_by === null && value.run.root === value.run.id;
}
function runState(value: unknown): value is RunState {
  if (!value || typeof value !== "object" || !("run" in value)) return false;
  if ("starts" in value && (!Array.isArray(value.starts) || !value.starts.every(s => s && typeof s.key === "string" && typeof s.run === "string" && idPattern.test(s.run)))) return false;
  if ("calls" in value && (!Array.isArray(value.calls) || value.calls.length > HARNESS_LIMITS.calls_per_minute || !value.calls.every(Number.isFinite))) return false;
  const r = value.run;
  return !!r && typeof r === "object" && "id" in r && typeof r.id === "string" && idPattern.test(r.id)
    && "root" in r && typeof r.root === "string" && idPattern.test(r.root)
    && "started_by" in r && (r.started_by === null || typeof r.started_by === "string" && idPattern.test(r.started_by))
    && "self" in r && typeof r.self === "string" && "depth" in r && typeof r.depth === "number" && Number.isInteger(r.depth) && r.depth >= 0 && r.depth <= 3
    && "created_ms" in r && typeof r.created_ms === "number" && Number.isFinite(r.created_ms) && "harness" in r && typeof r.harness === "string";
}

/** Whether the process is known gone: absent, or its pid now another process's. A reading that cannot tell keeps it. */
function ended(foreground: { pid: number; birth: string }): boolean {
  const reading = readProcessBirth(foreground.pid);
  return reading.state === "absent" || reading.state === "identified" && reading.birth.value !== foreground.birth;
}

export class RunStore {
  private readonly entries = new Map<string, Saved>();
  private readonly pending = new Map<string, { depth: number; hash: string; ceiling?: string }>();
  private readonly panes = new Map<string, PaneSaved>();
  constructor(readonly dir: string) {
    privateDir(dir);
    this.load("runs.json", this.entries, saved);
    this.load("pane-runs.json", this.panes, paneSaved);
  }
  private load<T extends RunState>(name: string, rows: Map<string, T>, valid: (row: unknown) => row is T): void {
    const file = join(this.dir, name);
    if (!existsSync(file)) return;
    try {
      const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(doc) && doc.every(valid)) for (const row of doc) rows.set(row.run.id, row);
    } catch {
      console.warn("Agent tool: unreadable run registry; existing credentials will not be accepted.");
    }
  }
  /** Each registry is written alone, so a pane registry that cannot be written never fails a token run, nor the reverse. */
  private save(which: "tokens" | "panes" = "tokens"): void {
    if (which === "panes") writePrivate(join(this.dir, "pane-runs.json"), JSON.stringify([...this.panes.values()]));
    else writePrivate(join(this.dir, "runs.json"), JSON.stringify([...this.entries.values()]));
  }
  private saveFor(id: string): void { this.save(this.panes.has(id) ? "panes" : "tokens"); }
  private row(id: string): RunState | undefined { return this.entries.get(id) ?? this.panes.get(id); }
  private put(id: string, row: RunState): void {
    const pane = this.panes.get(id), token = this.entries.get(id);
    if (pane) this.panes.set(id, { ...pane, ...row });
    else if (token) this.entries.set(id, { ...token, ...row });
  }
  /** Every call is proved by the hub; all callers in the same live pane share one depth-zero run. */
  bindPane(key: PaneKey): Run {
    for (const [id, pane] of this.panes) {
      if (pane.key.pane !== key.pane) continue;
      if (sameKey(pane.key, key)) return pane.run;
      this.panes.delete(id);
    }
    const id = randomBytes(8).toString("hex");
    const run: Run = { id, self: key.pane, depth: 0, started_by: null, root: id, harness: "hc-pane", created_ms: Date.now() };
    this.panes.set(id, { run, key });
    try { this.save("panes"); } catch (error) { this.panes.delete(id); throw error; }
    return run;
  }
  hasPaneRun(id: string): boolean { return this.panes.has(id); }
  knownPaneRuns(): ReadonlySet<string> { return new Set(this.panes.keys()); }
  /** Ignore runs created after the caller asked hc for its snapshot. */
  reconcilePanes(live: readonly PaneTerminal[], before: ReadonlySet<string>): void {
    const roots = new Map(live.filter(localPane).map(pane => [pane.address, pane]));
    let changed = false;
    for (const [id, { key }] of this.panes) {
      if (!before.has(id)) continue;
      const pane = roots.get(key.pane);
      if (pane?.pid === key.root && pane.created_ms === key.created_ms && procLink(key.root)?.birth === key.birth) continue;
      this.panes.delete(id);
      changed = true;
    }
    if (changed) this.save("panes");
  }
  clearPaneRuns(): void {
    if (this.panes.size === 0) return;
    this.panes.clear();
    this.save("panes");
  }
  /** Whether Ovis launched this pane's program with a token of its own: such a pane is never also a tokenless one. */
  tokenManaged(self: string): boolean { return [...this.entries.values()].some(({ run }) => run.self === self); }
  reserve(depth = 0, ceiling?: string) {
    const id = randomBytes(8).toString("hex");
    const dir = join(this.dir, "tokens");
    privateDir(dir);
    const tokenFile = join(dir, `${id}.token`);
    const token = `ovr1.${id}.${randomBytes(32).toString("base64url")}`;
    const hash = digest(token).toString("hex");
    writePrivate(tokenFile, token);
    this.pending.set(id, { depth, hash, ceiling });
    return { id, tokenFile, cancel: () => this.revoke(id),
      bind: (claims: Omit<Run, "id" | "created_ms">): Run => {
        if (!this.pending.delete(id)) throw new Error("Agent tool reservation has been revoked.");
        const run = { id, ...claims, created_ms: Date.now() };
        this.entries.set(id, { run, hash });
        try { this.save(); } catch (error) { this.entries.delete(id); throw error; }
        return run;
      } };
  }
  verify(token: string): Run | null {
    const id = /^ovr1\.([a-f0-9]{16})\.[A-Za-z0-9_-]{43}$/.exec(token)?.[1];
    const row = id ? this.entries.get(id) : undefined;
    if (!row || !timingSafeEqual(digest(token), Buffer.from(row.hash, "hex"))) return null;
    // a TUI quit back to its shell leaves the pane open: its run ends with the process it was given to
    if (row.run.started_by === null && row.foreground && ended(row.foreground)) { this.revoke(row.run.id); return null; }
    return row.run;
  }
  discovery(token: string) {
    const id = token.split(".")[1];
    const entry = id ? this.pending.get(id) : undefined;
    return entry && timingSafeEqual(digest(token), Buffer.from(entry.hash, "hex")) ? entry : undefined;
  }
  ancestors(run: Run): string[] {
    const chain: string[] = [];
    let id = run.started_by;
    while (id && chain.length < 3) {
      const parent = this.row(id)?.run;
      if (!parent) break;
      chain.push(parent.self);
      id = parent.started_by;
    }
    return chain;
  }
  previousStart(id: string, key: string): string | undefined { return this.row(id)?.starts?.find(s => s.key === key)?.run; }
  forgetFailedStart(id: string, failed: string): void {
    const row = this.row(id);
    if (!row?.starts?.some(s => s.run === failed)) return;
    this.put(id, { ...row, starts: row.starts.filter(s => s.run !== failed) });
    this.saveFor(id);
  }
  takeCall(id: string, now: number): boolean {
    const row = this.row(id);
    if (!row) return false;
    const calls = (row.calls ?? []).filter(at => at > now - 60_000);
    const max = HARNESS_LIMITS.calls_per_minute;
    this.put(id, { ...row, calls: [...calls, now].slice(-max) });
    this.saveFor(id);
    return calls.length < max;
  }
  rememberStart(id: string, key: string, child: string): void {
    const row = this.row(id);
    if (!row) throw new Error("Agent tool run has ended.");
    this.put(id, { ...row, starts: [...row.starts ?? [], { key, run: child }] });
    this.saveFor(id);
  }
  revoke(id: string): void {
    if (!idPattern.test(id)) return;
    if (this.panes.delete(id)) { this.save("panes"); return; }
    this.pending.delete(id);
    rmSync(join(this.dir, "tokens", `${id}.token`), { force: true });
    for (const end of [".json", ".js"]) rmSync(join(this.dir, "mcp", `${id}${end}`), { force: true });
    if (this.entries.delete(id)) this.save("tokens");
  }
  forgetTerminal(self: string, keep?: string): void {
    for (const { run } of [...this.entries.values(), ...this.panes.values()]) if (run.self === self && run.id !== keep) this.revoke(run.id);
  }
  rememberForeground(id: string, pid: number): void {
    const row = this.entries.get(id), reading = readProcessBirth(pid);
    if (row && reading.state === "identified") {
      this.entries.set(id, { ...row, foreground: { pid, birth: reading.birth.value } });
      this.save();
    }
  }
  reconcile(terminals: readonly LiveToolTerminal[], keeper: (address: string) => string | undefined): void {
    const live = new Map(terminals.filter(t => t.state === "live").map(t => [t.address, t]));
    for (const { run, foreground } of this.entries.values()) {
      const t = live.get(run.self);
      const config = join(this.dir, "mcp", `${run.id}.json`), extension = join(this.dir, "mcp", `${run.id}.js`);
      const argv = t?.foreground?.argv ?? [];
      const id = keeper(run.self);
      const birth = foreground && t?.foreground?.pid === foreground.pid ? readProcessBirth(foreground.pid) : null;
      const verified = run.started_by === null
        ? birth?.state === "identified" && birth.birth.value === foreground?.birth && argv.some((word, i) => (word === "--mcp-config" && argv[i + 1] === config) || (word === "-e" && argv[i + 1] === extension) || (word === "--additional-mcp-config" && argv[i + 1] === `@${config}`)
          || (word.startsWith("mcp_servers.ovis-agent.args=") && argv[i - 1] === "-c" && word.includes(`'${join(this.dir, "tokens", `${run.id}.token`)}'`)))
        : !!id && t?.labels["ovis.acp"] === id && t.labels["ovis.run"] === run.id;
      if (!verified) this.revoke(run.id);
    }
  }
  revokeAll(): void {
    this.pending.clear();
    this.entries.clear();
    this.panes.clear();
    for (const dir of ["tokens", "mcp"]) rmSync(join(this.dir, dir), { recursive: true, force: true });
    this.save("tokens");
    this.save("panes");
  }
}
