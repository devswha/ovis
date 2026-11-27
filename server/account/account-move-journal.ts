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

export class MoveJournalFile {
  readonly path: string;
  private readonly abortPath: string;
  private readonly paths: readonly string[];
  constructor(stateDir: string, sibling: string | null) {
    this.path = join(stateDir, ACCOUNT_MOVE_FILE);
    this.abortPath = join(stateDir, "account-move-abort.json");
    this.paths = [...new Set([this.path, ...(sibling === null ? [] : [join(sibling, ACCOUNT_MOVE_FILE)])])];
  }

  read() { return readMoveJournal(this.path); }

  aborted(): { id: string; from: string; answer: AccountMoveAborted } | null {
    try {
      const doc: unknown = JSON.parse(readFileSync(this.abortPath, "utf8"));
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
      if (typeof existing !== "object" || existing?.id !== intent.id || this.aborted()?.id === intent.id) return undefined;
      return work();
    });
  }

  remove(intent: MoveJournal, mayRemove: () => boolean, reason?: AccountMoveAborted["reason"]): boolean {
    // Unlink the active copy last so a crash during removal can retry.
    return this.lock(() => {
      const existing = this.read();
      if (typeof existing !== "object" || existing?.id !== intent.id || !mayRemove()) return false;
      // Keep the notice before unlinking. A stop between these writes still means this move was cancelled.
      if (reason !== undefined) writePrivateState(this.abortPath, { v: 1, id: intent.id, from: intent.from.account, into: intent.into, reason });
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
