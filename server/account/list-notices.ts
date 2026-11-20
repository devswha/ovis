import type { AccountRowPorts } from "./account-devices.ts";
import type { DeviceJournal, JournalEntry } from "./device-journal.ts";
import type { RemovalEvidence } from "./removal-evidence.ts";

/** The journal's admission number is PC-local. An open entry survives trimming of the replay log. */
export function listNotices(journal: DeviceJournal, evidence: RemovalEvidence, send: (entry: JournalEntry) => void): Pick<AccountRowPorts, "journal" | "publish" | "hasNoticeSlot"> {
  const current = (entry: { row: string; key: string; no?: number }) => {
    const notice = journal.openNotices().find((n) => n.row === entry.row && n.no === entry.no && n.key === entry.key);
    if (!notice) throw new Error("The current admission has no durable notice");
    return notice;
  };
  return {
    hasNoticeSlot: () => journal.admitsFromList(),
    journal(entry) {
      if (entry.kind === "its_me") {
        const notice = current(entry);
        send(journal.append({ ...notice, kind: "confirm", how: "its_me", by: entry.by ?? null }, notice.id));
        return;
      }
      const notice = journal.recordAccountRow(entry, evidence);
      if (notice && entry.kind === "drop") send(notice);
    },
    publish(entry) {
      const open = journal.openNotices().filter((n) => n.row === entry.row && n.key === entry.key && n.account === entry.account && n.how === "list").at(-1);
      if (open && open.no === entry.no) { send(open); return; }
      // Old builds used the account number. Never give an old notice ID authority over the repaired admission.
      const obsolete = open && open.no === entry.accountNo && !journal.entries().some((n) => n.row === entry.row && n.seq > open.seq) ? open.id : undefined;
      send(journal.append({ kind: "admit", how: "list", key: entry.key, no: entry.no ?? null, row: entry.row, label: entry.label ?? "", by: null, account: entry.account }, obsolete));
    },
  };
}
