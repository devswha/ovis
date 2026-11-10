import { randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { PairingIntent, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";
import type { DeviceMatch } from "../devices.ts";
import { writePrivateState } from "../private-state.ts";

/** Comparisons waiting on the owner at once; a phone past them is refused (`auth_failed`), so prompts cannot pile up. */
export const MAX_PENDING_APPROVALS = 3;
/** How long after the owner copies a link without a code this PC takes comparisons, as a Bluetooth device in pairing mode. */
export const PAIRING_WINDOW_MS = 10 * 60_000;

/** How a waiting comparison ended: approved (by this PC when `by` is absent, else by that account member) or not. */
export type PairingDecision = { approved: true; by?: DeviceMatch } | { approved: false };

/** What a remote approval came to: done, nothing waiting under that id, or the wrong digits picked (which ends it). */
export type RemoteDecision = { outcome: "decided"; device_id: string } | { outcome: "gone" | "wrong_digits" };

interface Waiting {
  request: RelayPairingRequest & { intent: PairingIntent };
  /** the new device's key, and the id its row will have (accountDeviceId) */
  key: string;
  deviceId: string;
  /** an account join taken outside the pairing window: shown to account members only (docs/account.md, design 5.3) */
  membersOnly: boolean;
  /** asked while this PC's own screen waited to be added to an account: decided on this PC only, never by a member */
  localOnly: boolean;
  choices: [string, string, string];
  finish: (decision: PairingDecision) => void;
}

function decoys(digits: string): [string, string, string] {
  const picked = new Set([digits]);
  while (picked.size < 3) picked.add(String(randomInt(0, 1_000_000)).padStart(6, "0"));
  const choices = [...picked];
  for (let index = choices.length - 1; index > 0; index--) {
    const other = randomInt(0, index + 1);
    [choices[index], choices[other]] = [choices[other]!, choices[index]!];
  }
  return choices as [string, string, string];
}

/**
 * The phones waiting for approval after both screens showed the same digits (server/relay/session.ts).
 * Held in memory only: a restart drops them with their sessions. The PC's own windows hear of every
 * change with the digits (`relay-pairings`); drive account members connected through the relay hear
 * of it with three candidates instead (`remote-pairings`, docs/account.md "Who may admit a device").
 *
 * The pairing window itself is kept in `path` when one is given, so a PC that restarts (an update)
 * while it waits to be added still takes the comparison it asked for: never past the ten minutes it
 * was opened for, and closed again by closeWindow.
 */
export class RelayPairingApprovals {
  private readonly waiting = new Map<string, Waiting>();
  private readonly listeners = new Set<(pairings: RelayPairingRequest[]) => void>();
  private readonly remoteListeners = new Set<(pairings: RemotePairingRequest[]) => void>();
  private windowUntil = 0;
  private localOnlyUntil = 0;
  private readonly path: string | undefined;
  private readonly now: () => number;

  constructor(options: { path?: string; now?: () => number } = {}) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.load();
  }

  /**
   * The saved window, when the file holds both deadlines: one without the other reads as closed, since
   * a window that came back without its local-only half would show what it takes to account members.
   * Neither is trusted past a window opened now, whatever the file says.
   */
  private load(): void {
    if (!this.path) return;
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(this.path, "utf8")); } catch { return; }
    if (typeof saved !== "object" || saved === null) return;
    const { v, window_until: windowUntil, local_only_until: localOnlyUntil } = saved as Record<string, unknown>;
    if (v !== 1) return;
    if (typeof windowUntil !== "number" || !Number.isFinite(windowUntil)) return;
    if (typeof localOnlyUntil !== "number" || !Number.isFinite(localOnlyUntil)) return;
    const latest = this.now() + PAIRING_WINDOW_MS;
    this.windowUntil = Math.min(windowUntil, latest);
    this.localOnlyUntil = Math.min(localOnlyUntil, latest);
  }

  /** Both deadlines in one write, so the file never holds one without the other. False when it could not be written. */
  private save(): boolean {
    if (!this.path) return true;
    try {
      writePrivateState(this.path, { v: 1, window_until: this.windowUntil, local_only_until: this.localOnlyUntil });
      return true;
    } catch (error) {
      console.warn(JSON.stringify({ event: "relay.pairing_window.save_failed", error: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }

  /**
   * The owner asked for a link without a code: comparisons are taken for PAIRING_WINDOW_MS from now.
   * `localOnly`: this PC's own screen waits to be added to an account (docs/account.md, "Adding a PC"),
   * so what is asked until then is decided here only, even once the PC has members who could approve.
   */
  openWindow(now = this.now(), options: { localOnly?: boolean } = {}): void {
    this.windowUntil = now + PAIRING_WINDOW_MS;
    if (options.localOnly) this.localOnlyUntil = now + PAIRING_WINDOW_MS;
    // a window that could not be saved still works until this process ends
    this.save();
  }

  /**
   * Ends the window now: the owner stopped waiting, revoked every device, reset the relay identity or
   * turned the relay off. Comparisons already waiting are not touched; their own sessions end them.
   */
  closeWindow(): void {
    const open = this.windowUntil !== 0 || this.localOnlyUntil !== 0;
    this.windowUntil = 0;
    this.localOnlyUntil = 0;
    if (!this.path || (!open && !existsSync(this.path))) return;
    // a file that cannot be rewritten must not bring the window back at the next start: absent reads as closed
    if (!this.save()) try { rmSync(this.path, { force: true }); } catch { /* reported by save() */ }
  }

  /** Whether a comparison taken now is this PC's own to decide: asked while its add-me screen waited. */
  localOnlyOpen(now = this.now()): boolean { return now < this.localOnlyUntil; }

  /** Outside the window a comparison is refused before any prompt, so nobody the owner did not invite can raise one. */
  windowOpen(now = this.now()): boolean { return now < this.windowUntil; }

  list(): RelayPairingRequest[] {
    return [...this.waiting.values()].filter(({ membersOnly }) => !membersOnly).map(({ request }) => request);
  }

  private readonly joins: number[] = [];

  /** Counts one account join asked for outside the pairing window; false past 5 a minute. */
  takeAccountJoin(now = Date.now()): boolean {
    while (this.joins.length && now - this.joins[0]! >= 60_000) this.joins.shift();
    if (this.joins.length >= 5) return false;
    this.joins.push(now);
    return true;
  }

  remoteList(): RemotePairingRequest[] {
    return [...this.waiting.values()].filter(({ localOnly }) => !localOnly).map(({ request, choices, key }) => ({
      id: request.id, label: request.label, intent: request.intent, choices, expires_at: request.expires_at, key,
    }));
  }

  /** Told the whole list at once, so a window that reconnects drops what was decided meanwhile, then on every change. */
  subscribe(listener: (pairings: RelayPairingRequest[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => { this.listeners.delete(listener); };
  }

  subscribeRemote(listener: (pairings: RemotePairingRequest[]) => void): () => void {
    this.remoteListeners.add(listener);
    listener(this.remoteList());
    return () => { this.remoteListeners.delete(listener); };
  }

  /** Null when MAX_PENDING_APPROVALS are already waiting. `withdraw` ends it unapproved (the phone left, or time ran out). */
  ask(label: string, digits: string, expiresAt: number, device: { intent: PairingIntent; key: string; deviceId: string; membersOnly?: boolean; localOnly?: boolean } = { intent: "pc", key: "", deviceId: "" }): { decision: Promise<PairingDecision>; withdraw: () => void } | null {
    if (this.waiting.size >= MAX_PENDING_APPROVALS) return null;
    const id = randomBytes(8).toString("hex");
    const decided = Promise.withResolvers<PairingDecision>();
    const finish = (decision: PairingDecision) => {
      if (!this.waiting.delete(id)) return;
      this.changed();
      decided.resolve(decision);
    };
    this.waiting.set(id, { request: { id, label, digits, expires_at: new Date(expiresAt).toISOString(), intent: device.intent }, key: device.key, deviceId: device.deviceId, membersOnly: device.membersOnly ?? false,
      // fixed when the phone asked (session.ts), so a window that closes before its digits are shown changes nothing
      localOnly: !(device.membersOnly ?? false) && (device.localOnly ?? this.localOnlyOpen()), choices: decoys(digits), finish });
    this.changed();
    return { decision: decided.promise, withdraw: () => finish({ approved: false }) };
  }

  /** On this PC. False for an id that is not waiting: never asked, already decided, withdrawn or expired. */
  decide(id: string, approved: boolean): boolean {
    const entry = this.waiting.get(id);
    // a join the PC's own windows were never shown is not theirs to decide
    if (!entry || entry.membersOnly) return false;
    entry.finish(approved ? { approved: true } : { approved: false });
    return true;
  }

  /**
   * From an account member through the relay, who must name the new device's digits. A wrong pick
   * declines it, so guessing among the three costs the comparison and counts as a failed pairing.
   */
  decideRemote(id: string, approved: boolean, digits: string, by: DeviceMatch): RemoteDecision {
    const entry = this.waiting.get(id);
    if (!entry || entry.localOnly) return { outcome: "gone" };
    if (!approved) { entry.finish({ approved: false }); return { outcome: "decided", device_id: entry.deviceId }; }
    if (digits !== entry.request.digits) { entry.finish({ approved: false }); return { outcome: "wrong_digits" }; }
    entry.finish({ approved: true, by });
    return { outcome: "decided", device_id: entry.deviceId };
  }

  private changed(): void {
    const pairings = this.list();
    for (const listener of this.listeners) listener(pairings);
    const remote = this.remoteList();
    for (const listener of this.remoteListeners) listener(remote);
  }
}
