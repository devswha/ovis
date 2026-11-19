/**
 * What an account-joined row may do on this PC (Step 2, rows P5, T36, T37, T40, R1 to R10). It removes only itself,
 * admits nobody, turns no lock on or off, and reaches no other PC through this one. One check guards every route and
 * the signed records, so no path grants more than another.
 */

export interface AccountCaller {
  readonly rowId: string;
  readonly key: string;
  readonly state: "live" | "hold";
}

export type RowAction =
  | { readonly action: "remove"; readonly key: string }
  | { readonly action: "revoke" | "label"; readonly rowId: string }
  | { readonly action: "block" | "lift"; readonly targetNewer: boolean }
  | { readonly action: "route"; readonly machine: string }
  | { readonly action: "add" | "revoke_all" | "link" | "pair_start" | "pair_cancel" | "enroll" | "approve" | "relay_account" | "lock" | "unlock" | "leave_account" | "forget" | "confirm" | "push_subscribe" | "webhook" };

export type RowRefusal = "not_yours" | "local_required" | "local_only" | "older_device" | "member_required" | "link_not_owner" | "join_hold";

export type RowVerdict = { readonly ok: true } | { readonly refused: RowRefusal };

const OK: RowVerdict = { ok: true };
const refuse = (refused: RowRefusal): RowVerdict => ({ refused });

export function accountRowMay(caller: AccountCaller, request: RowAction): RowVerdict {
  switch (request.action) {
    case "remove": return request.key === caller.key ? OK : refuse("not_yours");
    case "revoke":
    case "label": return request.rowId === caller.rowId ? OK : refuse("not_yours");
    case "block":
    case "lift":
      // in its join hold a row signs nothing but its own leave
      if (caller.state === "hold") return refuse("join_hold");
      return request.targetNewer ? OK : refuse("older_device");
    case "route": return request.machine === "local" ? OK : refuse("local_only");
    case "push_subscribe": return OK;
    case "add": return refuse("not_yours");
    case "link": return refuse("link_not_owner");
    case "revoke_all":
    case "lock":
    case "unlock":
    case "leave_account":
    case "forget":
    case "confirm": return refuse("local_required");
    case "pair_start":
    case "pair_cancel":
    case "enroll":
    case "approve":
    case "relay_account":
    case "webhook": return refuse("member_required");
  }
}
