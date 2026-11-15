import type { ServerContext } from "../dispatch.ts";
import { jsonResponse, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { PI_VOICE_PATH, PI_VOICE_STATUS_PATH } from "../../shared/pi-voice.ts";
import { handleScreenOpen, handleScreenRequest, isScreenPath } from "./screen.ts";
import { handlePiVoiceRequest } from "./pi-voice.ts";
import { handleFriendsRequest } from "./friends.ts";
import { handleSpeechRequest } from "./speech.ts";

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
  if (pathname === "/api/friends") { setRequestRoute(pathname); return handleFriendsRequest(request, ctx.services.friends); }
  if (pathname === "/api/speech") { ctx.timeout(request, 0); return handleSpeechRequest(request, ctx.services.speech); }
  if (pathname !== PI_VOICE_PATH && pathname !== PI_VOICE_STATUS_PATH) return null;
  return (async () => {
    if (!ctx.server) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
    const machines = ctx.services.core.machines;
    const machineId = pathname === PI_VOICE_PATH ? url.searchParams.get("machine_id") : null;
    if (machineId && machineId !== "local") {
      const endpoint = machines?.endpoint(machineId);
      if (!endpoint) return jsonResponse({ error: { code: "machine_offline", message: "This PC is disconnected" } }, 503);
      const machine = { endpoint, track: (close: () => void) => machines!.trackTerminal(machineId, close) };
      return handlePiVoiceRequest(request, url, ctx.server, ctx.services.piVoice, { ...caller, machine });
    }
    return handlePiVoiceRequest(request, url, ctx.server, ctx.services.piVoice, caller);
  })();
}
