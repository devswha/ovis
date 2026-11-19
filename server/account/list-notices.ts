import type { AccountRowPorts } from "./account-devices.ts";
import type { DeviceJournal, JournalEntry } from "./device-journal.ts";
import type { RemovalEvidence } from "./removal-evidence.ts";

/** The journal's admission number is PC-local. An open entry survives trimming of the replay log. */
export function listNotices(journal: DeviceJournal, evidence: RemovalEvidence, send: (entry: JournalEntry) => void): Pick<AccountRowPorts, "journal" | "publish"> {
  const current = (entry: { row: string; key: string; no?: number }) => {
    const notice = journal.openNotices().find((n) => n.row === entry.row && n.no === entry.no && n.key === entry.key);
    if (!notice) throw new Error("The current admission has no durable notice");
    return notice;
  };
  return {
    journal(entry) {
      if (entry.kind === "its_me") {
        const notice = current(entry);
        send(journal.append({ ...notice, kind: "confirm", how: "its_me", by: entry.by ?? null }, notice.id));
        return;
      }
      const notice = journal.recordAccountRow(entry, evidence);
      if (notice && entry.kind === "drop") send(notice);
    },
    publish(entry) { send(current(entry)); },
  };
}
