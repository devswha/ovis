import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAccountId } from "../../shared/account-list-invite.ts";
import { isIsoTime } from "../../shared/account-records.ts";
import { isSignInMethod, type SignInMethod } from "../../shared/account-devices-api.ts";
import type { AccountMoveAborted } from "../../shared/protocol.ts";
import { isJsonObject } from "../http.ts";
import { privateStateFs, privateStateRefusal, syncDirectory, writePrivateState } from "../private-state.ts";
import { withFileLock } from "./pc-binding.ts";

export const ACCOUNT_MOVE_FILE = "account-move.json";
const ID = /^[0-9a-f]{32}$/;

export interface MoveJournal {
  readonly v: 1;
  readonly id: string;
  readonly server_id: string;
  readonly from: { readonly account: string; readonly bind_id: string };
  readonly into: string;
  readonly provider?: SignInMethod;
  readonly started_at: string;
}

export function readMoveJournal(path: string): MoveJournal | "unreadable" | "unavailable" | null {
  if (privateStateRefusal(path) !== null) return "unreadable";
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(doc) || doc.v !== 1 || typeof doc.id !== "string" || !ID.test(doc.id) || typeof doc.server_id !== "string" || !ID.test(doc.server_id)
      || !isJsonObject(doc.from) || typeof doc.from.account !== "string" || !isAccountId(doc.from.account)
      || typeof doc.from.bind_id !== "string" || !ID.test(doc.from.bind_id)
      || typeof doc.into !== "string" || !isAccountId(doc.into) || doc.into === doc.from.account
      || !isIsoTime(doc.started_at) || (doc.provider !== undefined && !isSignInMethod(doc.provider))) return "unreadable";
    return { v: 1, id: doc.id, server_id: doc.server_id, from: { account: doc.from.account, bind_id: doc.from.bind_id },
      into: doc.into, started_at: doc.started_at, ...(doc.provider === undefined ? {} : { provider: doc.provider }) };
  } catch (error) {
    if (isJsonObject(error) && error.code === "ENOENT") return null;
    return error instanceof SyntaxError ? "unreadable" : "unavailable";
  }
}

const ABORT_FILE = "account-move-abort.json";
type Aborted = { readonly id: string; readonly from: string; readonly answer: AccountMoveAborted };

function readAborted(path: string): Aborted | null {
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(doc) || doc.v !== 1 || typeof doc.id !== "string" || !ID.test(doc.id) || typeof doc.from !== "string"
      || !isAccountId(doc.from) || typeof doc.into !== "string" || !isAccountId(doc.into)) return null;
    const reason = doc.reason;
    if (reason !== "cancelled" && reason !== "relay_limit" && reason !== "list_account" && reason !== "listing_changed" && reason !== "binding_changed") return null;
    return { id: doc.id, from: doc.from, answer: { state: "aborted", account: doc.into, reason } };
  } catch (error) {
    if (error instanceof SyntaxError || (isJsonObject(error) && error.code === "ENOENT")) return null;
    throw error;
  }
}

/** The move journal of this folder and its sibling, which a start copies across (account-merge.ts), and the notice of a move given up, kept in both. */
export class MoveJournalFile {
  readonly path: string;
  private readonly paths: readonly string[];
  private readonly abortPaths: readonly string[];
  constructor(stateDir: string, sibling: string | null) {
    const dirs = [...new Set([stateDir, ...(sibling === null ? [] : [sibling])])];
    this.path = join(stateDir, ACCOUNT_MOVE_FILE);
    this.paths = dirs.map((dir) => join(dir, ACCOUNT_MOVE_FILE));
    this.abortPaths = dirs.map((dir) => join(dir, ABORT_FILE));
  }

  read() { return readMoveJournal(this.path); }

  /** The last move given up, as either folder holds its notice (this one's first); with `id`, only that move's. */
  aborted(id?: string): Aborted | null {
    for (const path of this.abortPaths) {
      const notice = readAborted(path);
      if (notice !== null && (id === undefined || notice.id === id)) return notice;
    }
    return null;
  }

  begin(intent: MoveJournal): ReturnType<MoveJournalFile["read"]> {
    return this.lock(() => {
      const existing = this.read();
      if (existing !== null) return existing;
      const sibling = this.paths[1];
      const other = sibling === undefined ? null : readMoveJournal(sibling);
      if (typeof other === "string") return other;
      if (other !== null && (other.server_id !== intent.server_id || other.from.bind_id !== intent.from.bind_id)) return "unavailable";
      const chosen = other ?? intent;
      writePrivateState(this.path, chosen);
      return chosen;
    });
  }

  commit<T>(intent: MoveJournal, work: () => T): T | undefined {
    return this.lock(() => {
      const existing = this.read();
      if (typeof existing !== "object" || existing?.id !== intent.id || this.aborted(intent.id) !== null) return undefined;
      return work();
    });
  }

  remove(intent: MoveJournal, mayRemove: () => boolean, reason?: AccountMoveAborted["reason"]): boolean {
    // Unlink the active copy last so a crash during removal can retry.
    return this.lock(() => {
      const existing = this.read();
      if (typeof existing !== "object" || existing?.id !== intent.id || !mayRemove()) return false;
      // The notice goes to both folders before either journal does: a stop between these writes, then a start from
      // either folder, still finds the move given up
      if (reason !== undefined) for (const path of this.abortPaths) writePrivateState(path, { v: 1, id: intent.id, from: intent.from.account, into: intent.into, reason });
      for (const path of [...this.paths].reverse()) {
        const held = readMoveJournal(path);
        if (typeof held === "string") throw new Error("The move journal could not be read");
        if (held?.id !== intent.id) continue;
        privateStateFs.unlinkSync(path);
        syncDirectory(dirname(path), process.platform);
      }
      return true;
    });
  }

  private lock<T>(work: () => T): T {
    // Sibling import takes the same locks, in the same order.
    const [first, second] = [...this.paths].sort();
    return withFileLock(first ?? this.path, () => second === undefined ? work() : withFileLock(second, work));
  }
}
