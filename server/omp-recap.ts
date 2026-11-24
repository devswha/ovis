/**
 * GET /api/pane/recap: the recap omp 19 wrote for an OMP pane's session while its user was away, for the
 * composer's notices. omp keeps the text out of its transcript: once a session has sat idle after the
 * model's answer it asks for a short recap and saves it in `history.db` beside the session store
 * (`session_recaps`, packages/coding-agent/src/session/session-index.ts), leaving only a usage record in
 * the transcript. The newest recap of the session is answered while no message is newer than it: a
 * message after it means the user is back and the recap is stale, as omp's own `※ recap:` line scrolls
 * away. The database is opened read-only and never through a link; the text is capped. The dispatcher in
 * dispatch.ts resolves the pane's transcript behind the access gate.
 */
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { OmpRecap } from "../shared/protocol.ts";
import { transcriptHeader } from "./gjc-runtime.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";
import { ompDataDir } from "./omp.ts";

const MAX_RECAP_CHARS = 4000;
/** omp writes a recap only once its last message is the model's answer, which fits well within this */
const TAIL_BYTES = 256 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** When the newest message in the transcript's tail was written, or null when the tail holds none. */
function lastMessageAt(transcript: string): number | null {
  let fd: number;
  try { fd = openSync(transcript, OPEN_FLAGS); } catch { return null; }
  let text: string;
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    for (let got = 1; got > 0 && read < buffer.length; read += got) got = readSync(fd, buffer, read, buffer.length - read, start + read);
    text = buffer.toString("utf8", 0, read);
    // the first line of a tail is likely torn
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes('"type":"message"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
      const at = entry.type === "message" && typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(at)) return at;
    } catch { /* a line still being written */ }
  }
  return null;
}

export function ompRecap(transcript: string): OmpRecap | null {
  const data = ompDataDir(transcript);
  const session = transcriptHeader(transcript)?.id;
  if (data === null || typeof session !== "string") return null;
  const path = join(data, "history.db");
  try { if (!lstatSync(path).isFile()) return null; } catch { return null; }
  let row: { recap: string; created_at: number } | null;
  let db: Database;
  try { db = new Database(path, { readonly: true, create: false }); } catch { return null; }
  try {
    row = db.query<{ recap: string; created_at: number }, [number, string]>(
      `SELECT substr(recap, 1, ?) AS recap, created_at FROM session_recaps
       WHERE session_id = ? AND typeof(recap) = 'text' AND typeof(created_at) = 'integer'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(MAX_RECAP_CHARS, session);
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* nothing to keep */ }
  }
  const text = row?.recap.trim();
  if (!row || !text) return null;
  // created_at is in whole seconds: a message in the second the recap was saved counts as after it
  const at = row.created_at * 1000;
  const last = lastMessageAt(transcript);
  if (last === null || last >= at) return null;
  return { text, at: new Date(at).toISOString() };
}

export type RecapSources = { transcript: (paneId: string) => Promise<string | null> };

export async function handleRecapRequest(request: Request, url: URL, pathname: string, { transcript }: RecapSources): Promise<Response | null> {
  if (pathname !== "/api/pane/recap") return null;
  setRequestRoute(pathname);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  const paneId = url.searchParams.get("pane_id");
  if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
  try {
    const path = await transcript(paneId);
    return jsonResponse({ recap: path === null ? null : ompRecap(path) });
  } catch (error) {
    return errorResponse(error);
  }
}
