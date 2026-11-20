/**
 * The acts the recovery socket answers (docs/account.md, "Recovery at the PC"). Each request is parsed by the shared
 * contract; this PC's user, not the request, is named in the journal. Removing keys, lifting blocks and admitting keys
 * come with the device and log changes they need.
 */
import { AccountDevicesApiError, parseRecoveryAction } from "../../shared/account-devices-api.ts";
import { AlreadyReleasedError, ReleaseJournalError, releaseRefusal, type RecoveryReleases } from "./recovery.ts";

export function recoveryActs(options: { releases: RecoveryReleases; logReadable(): boolean; user: string }): (request: unknown) => Promise<unknown> {
  const { releases } = options;
  return async (request) => {
    let action;
    try { action = parseRecoveryAction(request); }
    catch (error) {
      if (error instanceof AccountDevicesApiError) return { error: error.message };
      throw error;
    }
    const pc = { logReadable: options.logReadable() };
    switch (action.act) {
      case "list":
        return {
          rows: releases.candidates().filter((row) => row.waiting !== null).map((row) => ({
            id: row.id, label: row.label, origin: row.origin, waiting: row.waiting, last_seen_at: row.lastSeenAt, refusal: releaseRefusal(row, pc),
          })),
        };
      case "release": {
        const candidates = releases.candidates();
        const chosen = [];
        for (const id of action.rows) {
          const row = candidates.find((candidate) => candidate.id === id);
          if (row === undefined || row.waiting === null) return { error: `${id} does not wait here` };
          const refusal = releaseRefusal(row, pc);
          if (refusal !== null) return { error: `${id} cannot be released: ${refusal}` };
          chosen.push(row);
        }
        try { releases.release(chosen, options.user); }
        catch (error) {
          if (error instanceof ReleaseJournalError || error instanceof AlreadyReleasedError) return { error: error.message };
          throw error;
        }
        return { released: chosen.map((row) => row.id) };
      }
      case "undo": {
        // the log is read as each act comes, not only at the start (S19): while it cannot be, nothing is changed
        if (!pc.logReadable) return { error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" };
        const undone = releases.undo(action.rows ?? undefined, options.user);
        return { releases: undone.releases, ...(undone.journalError === null ? {} : { warning: `The undo was not journalled: ${undone.journalError.message}` }) };
      }
      default:
        return { error: `${action.act} is not available on this PC yet` };
    }
  };
}
