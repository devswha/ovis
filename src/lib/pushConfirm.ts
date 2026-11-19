/**
 * Kept for where the PC cannot say (the open LAN signs in as no device and gets no delivery record, an older server
 * has no record at all): the setup guide's rule then reads it (lib/setupGuideFlow.ts alertsHere).
 */
import { ApiError } from "./api.ts";
import { browserStorage } from "./firstHints.ts";

export const PUSH_CONFIRM_KEY = "ovis:push-confirmed";

type ConfirmStorage = Pick<Storage, "getItem" | "setItem">;

export function recordConfirmation(endpoint: string, sent: boolean, storage: ConfirmStorage | null = browserStorage()): void {
  try { storage?.setItem(PUSH_CONFIRM_KEY, JSON.stringify({ endpoint, sent })); } catch {}
}

const UNDELIVERABLE = new Set(["push_failed", "subscription_gone", "subscription_not_found"]);

/**
 * A confirmation push that failed is kept only when the PC said this subscription gets no push: the push service
 * refused it or retired it, or the PC does not hold it. A request the PC never answered so (the network, a restart, a
 * watching device) says nothing of delivery.
 */
export function recordTestFailure(endpoint: string, error: unknown, storage: ConfirmStorage | null = browserStorage()): void {
  if (error instanceof ApiError && error.code !== null && UNDELIVERABLE.has(error.code)) recordConfirmation(endpoint, false, storage);
}

export function confirmation(endpoint: string | null, storage: ConfirmStorage | null = browserStorage()): boolean | null {
  if (endpoint === null || storage === null) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(PUSH_CONFIRM_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { endpoint: kept, sent } = value as { endpoint?: unknown; sent?: unknown };
    return kept === endpoint && typeof sent === "boolean" ? sent : null;
  } catch { return null; }
}
