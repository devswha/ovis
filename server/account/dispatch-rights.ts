import type { ServerContext } from "../dispatch.ts";
import { jsonResponse } from "../http.ts";
import { dispatchMutationRegistered } from "../dispatch-routes.ts";
import { accountReadAllowed, accountRouteAction, accountRouteGuard, accountRowMay } from "./account-row-rights.ts";

/** The account-session gate runs before a handler or a cross-PC forward can act. */
export function accountDispatchRefusal(request: Request, ctx: ServerContext): Response | null {
  if (ctx.peer.kind !== "relay" || !ctx.services.devices.isAccountRow(ctx.peer.device.id)) return null;
  const { device, key } = ctx.peer;
  const rows = ctx.services.accountRows;
  const access = rows?.access(device.id);
  const row = rows?.row(device.id);
  const fail = (code: string) => jsonResponse({ error: { code, message: "An account-joined device cannot do this from afar" } }, 403);
  if (access === undefined || row === null || row === undefined || row.key !== key) return fail("not_listed");
  if ("refused" in access) return fail(access.refused);

  const { pathname, searchParams } = new URL(request.url);
  // A socket can forward to another PC or carry the multi-PC event stream.
  if (pathname === "/api/machines" || pathname === "/api/machines/events") return fail("local_only");
  if (searchParams.has("machine_id") && searchParams.get("machine_id") !== "local") return fail("local_only");
  const localPath = pathname.replace(/^\/api\/machines\/local\//, "/api/");
  if (localPath.startsWith("/api/machines/")) return fail("local_only");
  if (request.method !== "GET" && !dispatchMutationRegistered(request.method, localPath)) return fail("account_route_denied");
  if (accountRouteGuard(request.method, localPath)) return null;
  const action = accountRouteAction(request.method, localPath)
    ?? (accountReadAllowed(request.method, localPath) ? { action: "read" as const } : null);
  if (action === null) return fail("account_route_denied");
  const verdict = accountRowMay({ rowId: row.id, key: row.key, state: row.state }, action);
  return "refused" in verdict ? fail(verdict.refused) : null;
}
