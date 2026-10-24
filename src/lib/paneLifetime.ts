import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { restoreDraft } from "./draft.ts";

/**
 * herdr gives pane IDs out again once it is replaced (#1608), and a pane's unsent state is stored
 * under its PC and pane ID alone (`paneStorageId`): the message draft and its sending lease, the
 * terminal line, the input held for the terminal, and the lens. So each PC's stored state says
 * which herdr it belongs to (`ovis:pane-lifetime:<PC>`, the snapshot's `herdr_lifetime`). When a
 * snapshot names another one, the earlier herdr's text leaves its panes for Recover unsent text
 * (`ovis:unsent:`), never deleted and never sent, and its lenses and leases go. A server restart
 * alone keeps the lifetime, and the state with it.
 *
 * A PC whose snapshot names no lifetime (an older bridge) keeps its pane state in this page only:
 * it survives reconnects, never reaches storage, and reads none of it. So does a PC whose stored
 * state another tab already gave to a herdr this page has not seen yet.
 */
export type UnsentKind = "message" | "line" | "held";
export interface UnsentText { id: string; machine_id: string; pane_id: string; pane_title?: string; kind: UnsentKind; text: string; at: number }

const KINDS: readonly (readonly [string, UnsentKind])[] = [["ovis:composer-draft:", "message"], ["ovis:terminal-line:", "line"], ["ovis:terminal-draft:", "held"]];
const LEASE_PREFIX = "ovis:composer-sending:";
const VIEW_PREFIX = "ovis:view:";
const RECORD_PREFIX = "ovis:pane-lifetime:";
export const UNSENT_PREFIX = "ovis:unsent:";
type PaneStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The PC and pane a pane-state key is about, and the kind of text it holds (null: a lens or a lease), or null for any other key. */
export function paneStateKey(key: string): { machineId: string; paneId: string; kind: UnsentKind | null } | null {
  const lease = key.startsWith(LEASE_PREFIX);
  const rest = lease ? key.slice(LEASE_PREFIX.length) : key;
  const draft = KINDS.find(([prefix]) => rest.startsWith(prefix));
  const prefix = draft?.[0] ?? (!lease && rest.startsWith(VIEW_PREFIX) ? VIEW_PREFIX : null);
  if (prefix === null) return null;
  const owner = rest.slice(prefix.length);
  const kind = lease || !draft ? null : draft[1];
  // paneStorageId: a local pane's ID as it is, another PC's `remote:<PC>:<pane>` with both encoded
  if (!owner.startsWith("remote:")) return owner ? { machineId: LOCAL_MACHINE, paneId: owner, kind } : null;
  const parts = owner.split(":");
  if (parts.length !== 3) return null;
  try { return { machineId: decodeURIComponent(parts[1]!), paneId: decodeURIComponent(parts[2]!), kind }; } catch { return null; }
}

function parseUnsent(id: string, raw: string | null): UnsentText | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { machine_id, pane_id, pane_title, kind, text, at } = value as Partial<UnsentText>;
    if (typeof machine_id !== "string" || typeof pane_id !== "string" || typeof text !== "string" || typeof at !== "number"
      || (kind !== "message" && kind !== "line" && kind !== "held")) return null;
    return { id, machine_id, pane_id, ...(typeof pane_title === "string" && pane_title ? { pane_title } : {}), kind, text, at };
  } catch { return null; }
}

export class PaneLifetimes {
  /** the herdr each PC's panes are drawn under on this page: its latest snapshot's lifetime, null when that names none */
  private readonly generations = new Map<string, string | null>();
  /** the last lifetime this page saw a snapshot name for each PC */
  private readonly proven = new Map<string, string>();
  /** each PC's pane titles in its latest snapshot, for the text it leaves to recovery */
  private readonly titles = new Map<string, Map<string, string>>();
  /** the pane state of PCs this page keeps out of storage */
  private readonly memory = new Map<string, string>();
  private readonly retired = new Set<(machineId: string) => void>();
  private readonly listeners = new Set<() => void>();
  private unsentCache: { raw: string; list: readonly UnsentText[] } | null = null;

  constructor(
    private readonly storage: () => Storage = () => window.localStorage,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** The lifetime this page draws a PC's panes under: undefined before its first snapshot, null when snapshots name none. */
  generation(machineId: string): string | null | undefined { return this.generations.get(machineId); }

  /** Whether this page keeps the PC's pane state in storage: its herdr is proven, and the stored state is that herdr's. */
  stored(machineId: string): boolean {
    const lifetime = this.generations.get(machineId);
    if (typeof lifetime !== "string") return false;
    try { return this.storage().getItem(RECORD_PREFIX + machineId) === lifetime; } catch { return false; }
  }

  private routed(key: string): boolean {
    const pane = paneStateKey(key);
    return pane === null || this.stored(pane.machineId);
  }

  /** Storage for the pane-state keys: the PC's own when it is stored, else this page's memory. */
  readonly paneStorage: PaneStorage = {
    getItem: (key) => this.routed(key) ? this.storage().getItem(key) : this.memory.get(key) ?? null,
    setItem: (key, value) => { if (this.routed(key)) this.storage().setItem(key, value); else this.memory.set(key, value); },
    removeItem: (key) => { if (this.routed(key)) this.storage().removeItem(key); else this.memory.delete(key); },
  };

  /** Called with a PC once its generation changed: the stores drop what they read for it. */
  onRetire(forget: (machineId: string) => void): () => void { this.retired.add(forget); return () => { this.retired.delete(forget); }; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { this.unsentCache = null; for (const listener of this.listeners) listener(); }
  storageChanged(key: string | null): void { if (key === null || key.startsWith(UNSENT_PREFIX)) this.notify(); }

  /**
   * Each roster before it is drawn (useMachineRoster): a PC whose snapshot names another herdr than
   * the page drew it under leaves its pane state to recovery in this same render. Only the page
   * that saw the stored herdr go retires the stored state; a page that is behind another tab
   * leaves it alone, and keeps its own state in memory until it catches up.
   */
  observe(machines: readonly Machine[], title: (pane: HerdrPane) => string): void {
    const changed: string[] = [];
    for (const machine of machines) {
      if (!machine.snapshot) continue;
      const next = machine.snapshot.herdr_lifetime ?? null;
      const titles = this.titles.get(machine.id) ?? new Map<string, string>();
      if (!this.generations.has(machine.id) || this.generations.get(machine.id) !== next) {
        this.retireMemory(machine.id, titles);
        this.generations.set(machine.id, next);
        if (next !== null) this.settle(machine.id, next, titles);
        changed.push(machine.id);
      }
      if (next !== null) this.proven.set(machine.id, next);
      this.titles.set(machine.id, new Map(machine.snapshot.panes.map((pane) => [pane.pane_id, title(pane)])));
    }
    for (const machineId of changed) for (const forget of this.retired) forget(machineId);
    if (changed.length > 0) this.notify();
  }

  private settle(machineId: string, next: string, titles: ReadonlyMap<string, string>): void {
    try {
      const storage = this.storage();
      const record = storage.getItem(RECORD_PREFIX + machineId);
      if (record === next) return;
      const last = this.proven.get(machineId);
      if (record !== null && last !== undefined && last !== record) return;
      // no record: what is stored was written before lifetimes were (or on a fresh page), and stays the pane's
      if (record !== null) this.retireStored(storage, machineId, titles);
      storage.setItem(RECORD_PREFIX + machineId, next);
    } catch { /* storage refused: the PC's state stays in this page */ }
  }

  private retireStored(storage: Storage, machineId: string, titles: ReadonlyMap<string, string>): void {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    for (const key of keys) {
      const pane = paneStateKey(key);
      if (pane?.machineId !== machineId) continue;
      if (pane.kind !== null) this.archive(storage, pane.machineId, pane.paneId, pane.kind, storage.getItem(key), titles);
      storage.removeItem(key);
    }
  }

  private retireMemory(machineId: string, titles: ReadonlyMap<string, string>): void {
    let storage: Storage | null = null;
    try { storage = this.storage(); } catch { /* no storage: page-only text has nowhere else to go */ }
    for (const [key, value] of [...this.memory]) {
      const pane = paneStateKey(key);
      if (pane?.machineId !== machineId) continue;
      this.memory.delete(key);
      if (pane.kind !== null && storage !== null) this.archive(storage, pane.machineId, pane.paneId, pane.kind, value, titles);
    }
  }

  private archive(storage: Storage, machineId: string, paneId: string, kind: UnsentKind, value: string | null, titles: ReadonlyMap<string, string>): void {
    // held input is stored with its flags and time; only its printable text is kept
    const text = kind === "held" ? restoreDraft(value, this.now()).text : value ?? "";
    if (text.trim() === "") return;
    const title = titles.get(paneId);
    const record = { machine_id: machineId, pane_id: paneId, ...(title && title !== paneId ? { pane_title: title } : {}), kind, text, at: this.now() };
    try { storage.setItem(UNSENT_PREFIX + this.newId(), JSON.stringify(record)); } catch { /* full or refused: the text cannot be kept */ }
  }

  /** The text earlier herdrs' panes left, newest first. */
  unsent = (): readonly UnsentText[] => {
    const found: [string, string][] = [];
    try {
      const storage = this.storage();
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(UNSENT_PREFIX)) found.push([key.slice(UNSENT_PREFIX.length), storage.getItem(key) ?? ""]);
      }
    } catch { /* storage refused: there is nothing kept */ }
    found.sort(([a], [b]) => a.localeCompare(b));
    const raw = JSON.stringify(found);
    if (this.unsentCache?.raw === raw) return this.unsentCache.list;
    const list = found.flatMap(([id, value]) => parseUnsent(id, value) ?? []).sort((a, b) => b.at - a.at);
    this.unsentCache = { raw, list };
    return list;
  };

  discard(id: string): void {
    try { this.storage().removeItem(UNSENT_PREFIX + id); } catch { /* storage refused */ }
    this.notify();
  }
}

export const paneLifetimes = new PaneLifetimes();
if (typeof window !== "undefined") window.addEventListener("storage", (event) => paneLifetimes.storageChanged(event.key));
