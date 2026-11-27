import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { isAccountId } from "../../shared/account-list-invite.ts";
import { JOIN_LINE_MAX_CHARS, JOIN_LINE_PREFIX } from "../../shared/account-list-join.ts";
import { isIsoTime } from "../../shared/account-records.ts";
import { isJsonObject } from "../http.ts";
import type { DeviceStore } from "../devices.ts";
import { privateStateFs, privateStateRefusal, syncDirectory, writePrivateState } from "../private-state.ts";
import { withFileLock } from "./pc-binding.ts";

export const ACCOUNT_MOVE_FILE = "account-move.json";
const HEX_ID = /^[0-9a-f]{32}$/;
const DEVICE_ID = /^[0-9a-f]{16}$/;
export const moveId = (value: unknown): value is string => typeof value === "string" && isAccountId(value);
export const moveInvite = (value: unknown): value is string => typeof value === "string" && value.length <= JOIN_LINE_MAX_CHARS && value.startsWith(JOIN_LINE_PREFIX);
export const moveCaller = (value: unknown): value is string => typeof value === "string" && (value === "pc" || DEVICE_ID.test(value));

export interface MoveJournal {
  readonly v: 1;
  readonly merge_id: string;
  readonly server_id: string;
  readonly from: { readonly account: string; readonly bind_id: string };
  readonly into: string;
  readonly invite: string;
  readonly by: string;
  readonly started_at: string;
}

export function readMoveJournal(path: string): MoveJournal | "unreadable" | "unavailable" | null {
  if (privateStateRefusal(path) !== null) return "unreadable";
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(doc) || doc.v !== 1 || !moveId(doc.merge_id) || typeof doc.server_id !== "string" || !HEX_ID.test(doc.server_id)
      || !isJsonObject(doc.from) || !moveId(doc.from.account) || typeof doc.from.bind_id !== "string" || !HEX_ID.test(doc.from.bind_id)
      || !moveId(doc.into) || doc.into === doc.from.account || !moveInvite(doc.invite) || !moveCaller(doc.by)
      || !isIsoTime(doc.started_at)) return "unreadable";
    return { v: 1, merge_id: doc.merge_id, server_id: doc.server_id, from: { account: doc.from.account, bind_id: doc.from.bind_id },
      into: doc.into, invite: doc.invite, by: doc.by, started_at: doc.started_at };
  } catch (error) {
    if (isJsonObject(error) && error.code === "ENOENT") return null;
    return error instanceof SyntaxError ? "unreadable" : "unavailable";
  }
}

/** Called with the journal lock held, after the caller found the file unreadable. */
function quarantineMoveJournal(path: string): string {
  const aside = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
  privateStateFs.renameSync(path, aside);
  syncDirectory(dirname(path), process.platform);
  return aside;
}

/** A move intent remains authoritative through a transient read error, but not after confirmed corruption. */
export class MoveJournalFile {
  private reportUnreadable = false;
  constructor(readonly path: string, private readonly devices: DeviceStore) {}

  takeUnreadable(): boolean {
    const report = this.reportUnreadable;
    this.reportUnreadable = false;
    return report;
  }

  read(): MoveJournal | "unavailable" | null {
    const journal = readMoveJournal(this.path);
    if (journal !== "unreadable") return journal;
    let aside: string;
    try {
      const checked = withFileLock(this.path, () => {
        const held = readMoveJournal(this.path);
        return held === "unreadable" ? { aside: quarantineMoveJournal(this.path) } : held;
      });
      if (checked === "unavailable" || checked === null || !("aside" in checked)) return checked;
      aside = basename(checked.aside);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return "unavailable";
    }
    this.reportUnreadable = true;
    console.warn(`[account] quarantined unreadable move journal as ${aside}`);
    try {
      this.devices.journalEvent({ kind: "account", how: "journal_unreadable", key: null, no: null, row: null,
        label: aside, by: null, account: this.devices.account() });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.warn("[account] the unreadable move journal could not be recorded in the device journal");
    }
    return null;
  }

  begin(intent: MoveJournal): { readonly journal: ReturnType<typeof readMoveJournal>; readonly fresh: boolean } {
    return withFileLock(this.path, () => {
      const kept = readMoveJournal(this.path);
      if (kept !== null) return { journal: kept, fresh: false };
      writePrivateState(this.path, intent);
      return { journal: intent, fresh: true };
    });
  }
}

export function removeMoveJournal(active: string, sibling: string | null, journal: MoveJournal): void {
  // Remove the sibling first. A stop between unlinks leaves this folder able to finish again.
  for (const path of new Set([...(sibling === null ? [] : [join(sibling, ACCOUNT_MOVE_FILE)]), active])) {
    if (readMoveJournal(path) === null) continue;
    withFileLock(path, () => {
      const held = readMoveJournal(path);
      if (held === "unavailable") throw new Error("The move journal could not be read");
      if (typeof held === "object" && held !== null && Bun.deepEquals(held, journal, true)) {
        privateStateFs.unlinkSync(path);
        syncDirectory(dirname(path), process.platform);
      }
    });
  }
}
