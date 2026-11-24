/**
 * The PCs of an account whose devices and PCs come in by its signed list (docs/account-list.md, "PCs of a list
 * account"), for a device that follows that list and is in it. They are what the list holds, by relay key, under the
 * names the list seals. The account service's directory only says how to reach one: its relay, and whether the PC was
 * lately there. A PC that the directory alone names is none of the account's, and a route the directory gives for
 * another key than the one the list holds is no route.
 *
 * The rows have the directory's form (DirectoryPc), marked `by_list`, so that everything that draws or opens the
 * account's PCs goes on as it does. What the account service says of a PC being new, or added before this device
 * joined, is dropped: a PC is new to this device for a day from when it first held the entry that brought the PC in,
 * unless it signed that entry itself or the PC was in before it.
 */
import type { AccountListView } from "./accountList.ts";
import { pageAccountList } from "./pageList.ts";
import type { DirectoryPc } from "./service.ts";

/** How long a PC that another member added is new to this device: it opens only by hand meanwhile, and its notice stays. */
export const NEW_LIST_PC_MS = 24 * 60 * 60_000;

/** The account's PCs as `view` holds them, or null where the directory stands as it is: this device is not in a list of `account`. */
export function pcsByList(view: AccountListView | null | undefined, account: string, directory: readonly DirectoryPc[], now: number): DirectoryPc[] | null {
  if (view == null || view.account !== account || view.status.at !== "following" || view.status.standing !== "in") return null;
  const listed = new Map(directory.map((pc) => [pc.server_id, pc]));
  return view.pcs.map((pc) => {
    const named = listed.get(pc.server_id);
    const route = named !== undefined && named.public_key === pc.endpoint && named.relay !== null ? named : undefined;
    const newUntil = pc.new_at === null ? null : pc.new_at * 1000 + NEW_LIST_PC_MS;
    const isNew = newUntil !== null && now < newUntil;
    const addedBy = isNew && pc.by !== null ? view.devices.find((device) => device.key === pc.by)?.name?.label : undefined;
    return {
      server_id: pc.server_id, label: pc.name?.label ?? pc.server_id.slice(0, 8), added_at: route?.added_at ?? "",
      last_seen_at: route?.last_seen_at ?? null, public_key: route === undefined ? null : pc.endpoint, relay: route?.relay ?? null,
      new_until: isNew ? new Date(newUntil).toISOString() : null, admitted_at: null, admitted_before_you: false, by_list: true as const,
      ...(addedBy === undefined ? {} : { added_by: addedBy }),
    };
  });
}

/** The account's PCs as this page lists them: by its list where this device is in one, by the account service's directory otherwise. */
export function pagePcs(account: string, directory: readonly DirectoryPc[], now = Date.now()): readonly DirectoryPc[] {
  return pcsByList(pageAccountList()?.view(), account, directory, now) ?? directory;
}

/** The relay key of a PC that the page's list holds for `account`, or null: such a PC leaves the account by an entry of the list. */
export function pageListPc(account: string, serverId: string): string | null {
  const view = pageAccountList()?.view();
  if (view == null || view.account !== account || view.status.at !== "following" || view.status.standing !== "in") return null;
  return view.pcs.find((pc) => pc.server_id === serverId)?.endpoint ?? null;
}
