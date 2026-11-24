/**
 * The vouches a PC in an account was handed in its devices' sessions, for the lists they named to it
 * (docs/account-list.md, "An account that was in use"): each a sign-in key's word, with its member key's, that the two
 * are one device's, already checked (heldVouches). One device hands its own in its session and another device its
 * own in another, so they are kept: a PC that was off while its devices signed in again follows their list once it
 * holds the vouches of both. After the pin they keep a device the PC put out by its old sign-in key out by its member
 * key too (heldOut).
 *
 * `account-list-vouches.json` (0600), for one relay identity and one binding; another's is no vouch here, and the next
 * write replaces it. Every write is lock, read, reconcile, write, as the binding's own file (pc-binding.ts): another
 * Ovis on the same folder loses nothing it kept.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { withFileLock } from "./pc-binding.ts";

export const ACCOUNT_LIST_VOUCHES_FILE = "account-list-vouches.json";
/** The most lists one binding keeps vouches for: a list a device names past these is refused, and none of these is pushed out by a caller. */
export const VOUCH_LISTS_MAX = 4;
/** The most vouches kept for one list: past these, the ones kept stay and a new one is not kept. */
export const VOUCHES_PER_LIST_MAX = 64;

export interface HeldVouch { readonly key: string; readonly device: string }
interface Scope { readonly serverId: string; readonly bindId: string }
interface VouchDoc { readonly v: 1; readonly server_id: string; readonly bind_id: string; readonly lists: Readonly<Record<string, readonly HeldVouch[]>> }

const LIST = /^[0-9a-f]{64}$/;

function parse(text: string): VouchDoc | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { v, server_id, bind_id, lists } = value as Record<string, unknown>;
  if (v !== 1 || typeof server_id !== "string" || typeof bind_id !== "string" || typeof lists !== "object" || lists === null || Array.isArray(lists)) return null;
  for (const [list, held] of Object.entries(lists)) {
    if (!LIST.test(list) || !Array.isArray(held)) return null;
    for (const one of held as unknown[]) {
      if (typeof one !== "object" || one === null || typeof (one as HeldVouch).key !== "string" || typeof (one as HeldVouch).device !== "string") return null;
    }
  }
  return value as VouchDoc;
}

export class ListVouches {
  private readonly path: string;
  /** What the file held at the last read or write, for the binding it was for. */
  private held: VouchDoc | null = null;
  private read = false;

  constructor(stateDir: string) { this.path = join(stateDir, ACCOUNT_LIST_VOUCHES_FILE); }

  /** The vouches kept for `list` under this binding. */
  of(scope: Scope, list: string): readonly HeldVouch[] {
    if (!this.read) { this.held = this.onDisk(); this.read = true; }
    const doc = this.held;
    return doc === null || !mine(doc, scope) ? [] : doc.lists[list] ?? [];
  }

  /** Keeps `vouches` for `list` beside what is kept. `full`: the binding keeps vouches for as many lists as it may, and none of them is `list`. Throws when the file cannot be written. */
  keep(scope: Scope, list: string, vouches: readonly HeldVouch[]): "kept" | "full" {
    return this.write(scope, (lists) => {
      const was = lists[list];
      if (was === undefined && Object.keys(lists).length >= VOUCH_LISTS_MAX) return null;
      const kept = [...was ?? []];
      for (const one of vouches) {
        if (kept.length >= VOUCHES_PER_LIST_MAX) break;
        if (!kept.some((held) => held.key === one.key && held.device === one.device)) kept.push({ key: one.key, device: one.device });
      }
      return { ...lists, [list]: kept };
    }) ? "kept" : "full";
  }

  /** The PC follows `list` now: the vouches of every other list go. */
  keepOnly(scope: Scope, list: string): void {
    this.write(scope, (lists) => ({ ...(lists[list] === undefined ? {} : { [list]: lists[list] }) }));
  }

  /** The binding went: so do its vouches. Never throws. */
  forget(): void {
    this.held = null;
    this.read = true;
    try { rmSync(this.path, { force: true }); } catch (error) { console.error(`[account] ${ACCOUNT_LIST_VOUCHES_FILE} could not be removed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`); }
  }

  private write(scope: Scope, change: (lists: VouchDoc["lists"]) => VouchDoc["lists"] | null): boolean {
    return withFileLock(this.path, () => {
      const disk = this.onDisk();
      const lists = change(disk !== null && mine(disk, scope) ? disk.lists : {});
      if (lists === null) { this.held = disk; this.read = true; return false; }
      const doc: VouchDoc = { v: 1, server_id: scope.serverId, bind_id: scope.bindId, lists };
      writePrivateState(this.path, doc);
      this.held = doc;
      this.read = true;
      return true;
    });
  }

  private onDisk(): VouchDoc | null {
    try { return parse(readFileSync(this.path, "utf8")); } catch { return null; }
  }
}

const mine = (doc: VouchDoc, scope: Scope): boolean => doc.server_id === scope.serverId && doc.bind_id === scope.bindId;
