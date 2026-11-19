/**
 * The one guard of a locked PC (docs/account.md, "Strict mode"), asked where access is decided and nowhere else. While
 * this PC's log holds a lock, a request gets in only as a row whose key was approved on this PC's screen (`origin.from`
 * `pc`) or as PC-local: a loopback window that gave local proof on the confirm page. The access token, Portal, a
 * Tailscale login and the open LAN count for nothing. While the log cannot be read (strict) only PC-local gets in, so
 * the owner repairs the PC at its screen or with `ovis recover`.
 */
import type { Access } from "./access.ts";

export interface LockScope { readonly locked: boolean; readonly strict: boolean }

export function lockBoundary(access: Access, scope: LockScope, request: {
  localProof: boolean;
  originOf(rowId: string): { from: string; how: string } | null;
}): Access {
  if (access.level !== "full" || (!scope.locked && !scope.strict)) return access;
  const pcLocal = access.via === "local" && request.localProof;
  if (pcLocal) return access;
  const reason = scope.strict ? "strict" : "locked";
  if (scope.strict) return { level: "none", reason };
  const rowFromScreen = (access.via === "device" || access.via === "relay") && access.device !== undefined
    && request.originOf(access.device.id)?.from === "pc";
  return rowFromScreen ? access : { level: "none", reason };
}
