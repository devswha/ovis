import type { ServerContext } from "../dispatch.ts";
import { jsonResponse, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { PI_VOICE_PATH, PI_VOICE_STATUS_PATH } from "../../shared/pi-voice.ts";
import { handleScreenOpen, handleScreenRequest, isScreenPath } from "./screen.ts";
import { handlePiVoiceRequest } from "./pi-voice.ts";
import { handleFriendsRequest } from "./friends.ts";
import { handleSpeechRequest } from "./speech.ts";
import { handleGithubAction, handleGithubFiles, handleGithubPull, handleGithubPulls } from "./github.ts";
import { handleGithubClone } from "./github-clone.ts";
import { handleNotes } from "./notes.ts";
import { handleInboxWidget } from "./inbox-widget.ts";
import { INBOX_WIDGET_PATH } from "../../shared/fork/inbox-widget.ts";

/** null is not our route; a promise resolving undefined is a successful socket upgrade. */
export function routeForkScreen(request: Request, url: URL, ctx: ServerContext, readOnly: boolean): Promise<Response | undefined> | null {
  const { pathname } = url;
  if (pathname !== "/api/screen" && !isScreenPath(pathname)) return null;
  return (async () => {
    setRequestRoute(pathname === "/api/screen" ? pathname : "/screen");
    if (readOnly) return jsonResponse({ error: { code: "read_only", message: "This device only watches" } }, 403);
    const pageLoad = request.method === "GET" && request.headers.get("upgrade") === null;
    if (!pageLoad && !sameOrigin(request)) return jsonResponse({ error: { code: "invalid_origin", message: "Use controls from this app" } }, 403);
    if (pathname === "/api/screen") return handleScreenOpen(request, ctx.services.core.machines?.list() ?? []);
    if (!ctx.server) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
    ctx.timeout(request, 0);
    return handleScreenRequest(request, url, ctx.server);
  })();
}

/** Called only after upstream's authentication, origin, drive and observe guards. */
export function routeForkApi(request: Request, url: URL, ctx: ServerContext, caller: { readOnly: boolean; deviceId: string | undefined; headers: Headers }): Promise<Response | undefined> | null {
  const { pathname } = url;
  if (pathname === "/api/fork/github/clone") { setRequestRoute(pathname); ctx.timeout(request, 0); return handleGithubClone(request, url, caller.readOnly, () => ctx.services.core.clientSnapshot()); }
  if (pathname === "/api/fork/github/pull/action") { setRequestRoute(pathname); ctx.timeout(request, 45); return handleGithubAction(request, caller.readOnly); }
  if (pathname === "/api/fork/github/pull/files") { setRequestRoute(pathname); ctx.timeout(request, 45); return handleGithubFiles(request, caller.readOnly); }
  if (pathname === "/api/fork/github/pull") { setRequestRoute(pathname); ctx.timeout(request, 45); return handleGithubPull(request, caller.readOnly); }
  if (pathname === "/api/fork/github/pulls") { setRequestRoute(pathname); ctx.timeout(request, 75); return handleGithubPulls(request, () => ctx.services.core.clientSnapshot(), caller.readOnly); }
  if (pathname === "/api/fork/notes" || pathname === "/api/fork/notes/file") { setRequestRoute(pathname); return handleNotes(request, url, caller.readOnly); }
  if (pathname === INBOX_WIDGET_PATH) { setRequestRoute(pathname); return handleInboxWidget(request, ctx.services.core.push, caller.deviceId ?? null); }
  if (pathname === "/api/friends") { setRequestRoute(pathname); return handleFriendsRequest(request, ctx.services.friends, async () => ctx.services.core.machines?.list() ?? [{ id: "local", snapshot: await ctx.services.core.clientSnapshot() }]); }
  if (pathname === "/api/speech") { ctx.timeout(request, 0); return handleSpeechRequest(request, ctx.services.speech); }
  if (pathname !== PI_VOICE_PATH && pathname !== PI_VOICE_STATUS_PATH) return null;
  return (async () => {
    const machines = ctx.services.core.machines;
    const machineId = pathname === PI_VOICE_PATH ? url.searchParams.get("machine_id") : null;
    if (machineId && machineId !== "local") {
      const endpoint = machines?.endpoint(machineId);
      if (!endpoint) return jsonResponse({ error: { code: "machine_offline", message: "This PC is disconnected" } }, 503);
      const machine = { endpoint, track: (close: () => void) => machines!.trackTerminal(machineId, close) };
      return handlePiVoiceRequest(request, url, ctx.upgrade, ctx.services.piVoice, { ...caller, machine });
    }
    return handlePiVoiceRequest(request, url, ctx.upgrade, ctx.services.piVoice, caller);
  })();
}
