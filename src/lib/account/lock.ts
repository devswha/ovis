/**
 * Strict mode through this PC's lock routes (Track B, S2-18): reading the state, and asking the PC to put a lock or
 * a named unlock on its own screen. A request grants nothing; the PC writes the record only when its screen approves
 * that exact act, and a window that is not this PC's own is refused (local_required).
 */
import type { LockState } from "../../components/StrictModePanel.tsx";
import { apiFetch } from "../api-request-id.ts";
import { errorFrom } from "../api.ts";

/** How long the PC's screen keeps an asked act open (CONFIRM_MS in server/account/local-confirm.ts). */
export const CONFIRM_WINDOW_MS = 2 * 60_000;

const LOCK = "/api/account/lock";
const UNLOCK = "/api/account/unlock";

export async function fetchLockState(): Promise<LockState> {
  const response = await apiFetch(LOCK);
  if (!response.ok) throw await errorFrom(LOCK, response);
  return await response.json() as LockState;
}

async function ask(url: string, body: unknown): Promise<string> {
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json() as { confirm: string }).confirm;
}

/** The confirmation the PC's screen now shows for turning strict mode on. */
export function requestLock(): Promise<string> {
  return ask(LOCK, {});
}

/** The confirmation the PC's screen now shows for ending lock `lock`. */
export function requestUnlock(lock: string): Promise<string> {
  return ask(UNLOCK, { lock });
}
