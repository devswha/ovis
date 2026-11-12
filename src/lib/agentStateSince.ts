/**
 * How long each agent has been in its state (#3505). herdr reports no time of change, so this device
 * stamps a change when it sees one and keeps the stamps, per PC and pane, across reloads. Done and
 * idle are one state here: reading a finished agent turns done into idle, and looking is not the
 * agent doing anything. A state this device did not see begin has no stamp, and its row says no
 * time rather than a wrong one.
 */
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { agentGroup, type AgentGroup } from "./agentRoster.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { stateSeqs } from "./sidebarOrder.ts";

/** the states a stamp tells apart: the list's groups, with done filed under idle */
export type StampState = Exclude<AgentGroup, "done">;

export function stampState(group: AgentGroup): StampState {
  return group === "done" ? "idle" : group;
}

export interface StateStamp {
  state: StampState;
  /** when the state began, as this device's clock said it */
  at: number;
  /** herdr's `state_change_seq` when it was stamped: the same number later proves nothing changed meanwhile */
  seq?: number;
}

/** one PC's stamps, by pane, under the herdr they were made on (the snapshot's `herdr_lifetime`): another herdr gives its pane ids to other panes */
export interface PcStamps { lifetime: string | null; rows: Readonly<Record<string, StateStamp>> }
export type StateStamps = Readonly<Record<string, PcStamps>>;

export interface SeenRow { pane: string; state: StampState; seq: number | undefined }
/** one look at a PC: its agent rows, or null while it is away or its roster has not come */
export interface PcLook { id: string; lifetime: string | null; rows: readonly SeenRow[] | null }
/** the states this page saw at its last look, by PC and pane: a state that differs from them changed in sight */
export type LastLook = ReadonlyMap<string, ReadonlyMap<string, StampState>>;
/** what a page carries from one look to the next: the device's stamps, and the states it saw last */
export interface SeenStamps { stamps: StateStamps; last: LastLook }

/**
 * A look at every PC: the agent rows the Agents list draws for it (lib/sidebarAgents.ts), each with the state it
 * shows and herdr's counter. A PC that is away, or whose roster has not come, says nothing of its agents now.
 */
export function stateLooks(machines: readonly Machine[], status: (machineId: string, pane: SidebarAgent["pane"]) => AgentStatus | undefined): PcLook[] {
  return machines.map((machine): PcLook => {
    if (machine.state !== "connected" || machine.snapshot === null) return { id: machine.id, lifetime: null, rows: null };
    const seqs = stateSeqs(machine.snapshot);
    return {
      id: machine.id,
      lifetime: machine.snapshot.herdr_lifetime ?? null,
      rows: sidebarAgents(machine.snapshot).map(({ pane }) => ({ pane: pane.pane_id, state: stampState(agentGroup(status(machine.id, pane))), seq: seqs.get(pane.pane_id) })),
    };
  });
}

/** a stamp of a pane no longer listed is kept this long, so a pane that leaves the roster for a moment keeps its time */
const KEPT_UNLISTED_MS = 30 * 86_400_000;

/**
 * Whether a kept stamp still tells of the row as it is: the same state, and by herdr's counter no change since.
 * A herdr that counts nothing proves nothing: the state may have gone and come back out of sight.
 */
function stillTrue(stamp: StateStamp | undefined, row: SeenRow): stamp is StateStamp {
  return stamp !== undefined && stamp.state === row.state && stamp.seq !== undefined && stamp.seq === row.seq;
}

/**
 * The stamps after a look at every PC. A row whose state changed since this page's last look, or
 * that appeared in a roster this page was watching, is stamped `now`. A row first seen by this
 * page (a reload, a PC back from away) keeps its stamp only while it still tells of it, and has
 * none otherwise: the change happened out of sight. A PC that is away keeps its stamps untouched.
 * Hands back the very `stamps` it was given when nothing changed.
 */
export function advanceStateStamps({ stamps, last }: SeenStamps, looks: readonly PcLook[], now: number): SeenStamps {
  const next: Record<string, PcStamps> = {};
  const seen = new Map<string, ReadonlyMap<string, StampState>>();
  let changed = false;
  const looked = new Set(looks.map((look) => look.id));
  for (const look of looks) {
    const kept = stamps[look.id];
    if (look.rows === null) {
      if (kept !== undefined) next[look.id] = kept;
      continue;
    }
    // another herdr: its pane ids start over, so no stamp of the old one tells of a pane of this one
    const before = kept !== undefined && kept.lifetime === look.lifetime ? kept.rows : {};
    const watched = last.get(look.id);
    const rows: Record<string, StateStamp> = {};
    const listed = new Set<string>();
    for (const row of look.rows) {
      listed.add(row.pane);
      const stamp = before[row.pane];
      const sawBefore = watched?.get(row.pane);
      const seq = row.seq === undefined ? {} : { seq: row.seq };
      // in a roster this page watches, a state that differs from the last look began now; a row that only left the
      // roster for a look is no such change, while its kept stamp still tells of it
      if (watched !== undefined && sawBefore !== row.state && !(sawBefore === undefined && stillTrue(stamp, row))) {
        rows[row.pane] = { state: row.state, at: now, ...seq };
        continue;
      }
      // a row this page was watching keeps its stamp through a counter that moved within one state (done read as
      // idle); one it sees for the first time keeps it only while herdr's counter proves it
      const held = watched !== undefined ? (stamp?.state === row.state ? stamp : undefined) : (stillTrue(stamp, row) ? stamp : undefined);
      // a clock set back never leaves a stamp in the future
      if (held !== undefined) rows[row.pane] = { state: held.state, at: Math.min(held.at, now), ...seq };
    }
    for (const [pane, stamp] of Object.entries(before)) if (!listed.has(pane) && now - stamp.at <= KEPT_UNLISTED_MS) rows[pane] = stamp;
    // a PC with no stamp has no entry: a look that stamps nothing changes nothing, and is not written
    if (kept !== undefined && kept.lifetime === look.lifetime && sameRows(kept.rows, rows)) next[look.id] = kept;
    else if (Object.keys(rows).length > 0) { next[look.id] = { lifetime: look.lifetime, rows }; changed = true; }
    else if (kept !== undefined) changed = true;
    seen.set(look.id, new Map(look.rows.map((row) => [row.pane, row.state])));
  }
  // a PC no longer in the roster (removed, or hidden on this device) keeps its stamps while any is recent enough to matter
  for (const [id, kept] of Object.entries(stamps)) {
    if (looked.has(id)) continue;
    const rows = Object.fromEntries(Object.entries(kept.rows).filter(([, stamp]) => now - stamp.at <= KEPT_UNLISTED_MS));
    if (Object.keys(rows).length === 0) { changed = true; continue; }
    if (sameRows(kept.rows, rows)) next[id] = kept;
    else { next[id] = { lifetime: kept.lifetime, rows }; changed = true; }
  }
  return { stamps: changed ? next : stamps, last: seen };
}

function sameRows(left: Readonly<Record<string, StateStamp>>, right: Readonly<Record<string, StateStamp>>): boolean {
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length && entries.every(([pane, a]) => {
    const b = right[pane];
    return b !== undefined && a.state === b.state && a.at === b.at && a.seq === b.seq;
  });
}

/** When the row's state began, if this device saw it: null for a state that differs from the stamp (a change not stamped yet) or was never stamped. */
export function stateSince(stamps: StateStamps, machineId: string, pane: string, state: StampState): number | null {
  const stamp = stamps[machineId]?.rows[pane];
  return stamp !== undefined && stamp.state === state ? stamp.at : null;
}

/** kept on this device, as its folds are: a phone and a desktop each stamp what they saw */
export const STATE_STAMPS_KEY = "ovis:agent-state-since";

const STAMP_STATES = ["blocked", "working", "idle"] as const satisfies readonly StampState[];
const isStampState = (value: unknown): value is StampState => STAMP_STATES.some((state) => state === value);
/** stored JSON read as an object of unknown fields, or null for anything else */
const fieldsOf = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

/** The stored stamps, each field checked: anything else stored there is dropped. */
export function parseStateStamps(raw: string | null): StateStamps {
  if (raw === null) return {};
  let stored: unknown;
  try { stored = JSON.parse(raw); } catch { return {}; }
  const record = fieldsOf(stored);
  const pcs = record?.["version"] === 1 ? fieldsOf(record["pcs"]) : null;
  if (pcs === null) return {};
  const stamps: Record<string, PcStamps> = {};
  for (const [id, pc] of Object.entries(pcs)) {
    const rows = fieldsOf(fieldsOf(pc)?.["rows"]);
    if (rows === null) continue;
    const kept: Record<string, StateStamp> = {};
    for (const [pane, value] of Object.entries(rows)) {
      const { state, at, seq } = fieldsOf(value) ?? {};
      if (!isStampState(state) || typeof at !== "number" || !Number.isFinite(at)) continue;
      kept[pane] = { state, at, ...(typeof seq === "number" && Number.isFinite(seq) ? { seq } : {}) };
    }
    const lifetime = fieldsOf(pc)?.["lifetime"];
    stamps[id] = { lifetime: typeof lifetime === "string" ? lifetime : null, rows: kept };
  }
  return stamps;
}

/** The stamps this device keeps, or null where its storage cannot be read: the page then goes by its own. */
export function loadStateStamps(): StateStamps | null {
  try { return parseStateStamps(window.localStorage.getItem(STATE_STAMPS_KEY)); } catch { return null; }
}

/** Whether the stamps were kept: false in private mode or over quota, where the page keeps them for its own time. */
export function saveStateStamps(stamps: StateStamps): boolean {
  try {
    window.localStorage.setItem(STATE_STAMPS_KEY, JSON.stringify({ version: 1, pcs: stamps }));
    return true;
  } catch {
    return false;
  }
}
