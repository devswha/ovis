import type { ConversationResponse, PullRequestListing } from "../../shared/protocol.ts";
import type { PiVoiceStatus } from "../../shared/pi-voice.ts";
import { machinePath } from "../../shared/machines.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { errorFrom, getJson, sendJson } from "../lib/api.ts";
import { observeWaitingClock, waitingKey } from "../lib/sentWaiting.ts";

/** A held newest page asks only for changed turns; a fresh read omits the 304 validator. */
export async function readForkConversation(requestUrl: string, url: string, known: { etag: string; body: ConversationResponse } | undefined, fresh: boolean | undefined, signal: AbortSignal, machineId: string, paneId: string) {
  const held = known === undefined ? requestUrl : `${requestUrl}&delta=${encodeURIComponent(known.etag)}`;
  const response = await apiFetch(held, { cache: "no-store", signal, ...(known && !fresh ? { headers: { "if-none-match": known.etag } } : {}) });
  const received = performance.now(), receivedWall = Date.now();
  if (response.status === 304 && known) {
    observeWaitingClock(waitingKey(machineId, paneId), response.headers.get("x-server-time"), received, receivedWall, true);
    return { response, body: known.body, whole: true };
  }
  if (!response.ok) throw await errorFrom(url, response);
  const { delta, ...answer } = (await response.json()) as ConversationResponse & { delta?: { drop: number; keep: number } };
  observeWaitingClock(waitingKey(machineId, paneId), response.headers.get("x-server-time") ?? answer.server_time, received, receivedWall);
  if (delta === undefined || known === undefined) return { response, body: answer, whole: true };
  return { response, body: { ...answer, turns: [...known.body.turns.slice(delta.drop, delta.drop + delta.keep), ...answer.turns] }, whole: false };
}

/** The repo's open pull requests, read with its gh account and never cached. */
export function listPullRequests(workspaceId: string, machineId = "local"): Promise<PullRequestListing> {
  return getJson<PullRequestListing>(`${machinePath(machineId, "worktree/pull-requests")}?workspace_id=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
}

/** Fetch the branch from origin and return the ref a worktree starts from. */
export async function fetchPullRequestBranch(workspaceId: string, branch: string, machineId = "local"): Promise<{ ref: string }> {
  const response = await sendJson(machinePath(machineId, "worktree/pull-request-fetch"), "POST", { workspace_id: workspaceId, branch });
  return (await response.json()) as { ref: string };
}

/** Whether this pane's Pi can take a live voice call, and whether one is on. */
export async function fetchPiVoiceStatus(paneId: string, machineId = "local"): Promise<PiVoiceStatus> {
  return getJson<PiVoiceStatus>(machinePath(machineId, `pane/pi-voice?pane_id=${encodeURIComponent(paneId)}`));
}
