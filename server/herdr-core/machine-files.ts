import { posix } from "node:path";

import type { FileInfo } from "../../shared/files.ts";
import { directoryListing } from "../directories.ts";
import { byteRange, crossSiteFileRead, fileHeaders, kindFrom, mimeOf } from "../file-view.ts";
import { badRequest, isJsonObject, jsonResponse } from "../http.ts";
import { PasteImageError, pastedImage, readImageBody } from "../paste.ts";
import { HcError, type HcConnection } from "./connection.ts";
import { onOtherMachine } from "./snapshot.ts";

/**
 * The files of one of the core's other machines, for the server that shows it as a PC of its own
 * (machine-entry.ts): the Files view's folders, the file viewer's files, and a pasted image put beside
 * a terminal there. Nothing of Ovis runs on that machine, so its own `/bin/sh` reads them through this
 * PC's core (`machine.exec`), as git already runs there (adapter.ts `gitOnMachine`): as that machine's
 * user, so nothing is read that a terminal there could not read, and a link is followed as it is there.
 * One answer is at most hc's 8 MB of output: a larger file is described, never sent in part. Pages
 * rendered with their own files, edits, diffs, git, Markdown lists, searches and new folders stay
 * refused (dispatch.ts OTHER_MACHINE_FILES).
 */

export type MachineHc = Pick<HcConnection, "call" | "hello">;

/** hc's own limit for what it carries in one call (`terminal.put`'s data, `machine.exec`'s output), in decimal megabytes to stay under it either way. */
const HC_BYTES = 8_000_000;
/** The most of a file sent: hc's limit less its path and facts written before it. */
export const MACHINE_FILE_BYTES = HC_BYTES - 8192;
const SNIFF_BYTES = 8192;
/** How long the machine is given for one read, and the call for its answer to come back. */
const EXEC_SECONDS = 20;
const CALL_MS = 30_000;

/**
 * `$1` what to do (`list`, `stat`, `read`), `$2` the path as written (empty or `~` for home, `~/…`, absolute,
 * or relative to `$3`, the pane's folder). Every value is printed NUL-terminated, so any name survives.
 * - list: home, the folder as `cd` resolves it, then `<d|f|l> <size> <name>` for each entry, `-L`: a link
 *   is what it points at (`l`: dangling). GNU find gives them in one pass; elsewhere a loop of `test`.
 * - stat: the file's path, size and modification time, then its first bytes, to tell text from binary.
 * - read: the same facts, then the whole file, when it is at most `$4` bytes.
 * Exit 2: not a folder; 3: a relative path without a folder; 4: no readable file; 5: too large.
 */
const SCRIPT = `unset CDPATH
op=$1 p=$2 base=$3
case $p in
  ""|"~") p=$HOME ;;
  "~/"*) p=$HOME/\${p#"~/"} ;;
  /*) ;;
  *) [ -n "$base" ] || exit 3; p=$base/$p ;;
esac
if [ "$op" = list ]; then
  cd -- "$p" 2>/dev/null || exit 2
  printf '%s\\000%s\\000' "$HOME" "$(pwd)"
  if find . -maxdepth 0 -printf '' 2>/dev/null; then
    find -L . -mindepth 1 -maxdepth 1 -printf '%y %s %f\\000' 2>/dev/null
  else
    for f in ./* ./.[!.]* ./..?*; do
      [ -e "$f" ] || continue
      if [ -d "$f" ]; then printf 'd 0 %s\\000' "\${f#./}"
      elif [ -f "$f" ]; then printf 'f %s %s\\000' "$(wc -c < "$f" 2>/dev/null | tr -d ' ')" "\${f#./}"
      fi
    done
  fi
  exit 0
fi
d=\${p%/*} n=\${p##*/}
[ -n "$n" ] && [ "$n" != . ] && [ "$n" != .. ] || exit 4
cd -- "\${d:-/}" 2>/dev/null || exit 4
[ -f "./$n" ] && [ -r "./$n" ] || exit 4
s=$(wc -c < "./$n" | tr -d ' ') || exit 4
t=$(date -r "./$n" +%s 2>/dev/null || stat -c %Y -- "./$n" 2>/dev/null || stat -f %m -- "./$n" 2>/dev/null) || t=0
d=$(pwd)
printf '%s\\000%s\\000%s\\000' "\${d%/}/$n" "$s" "$t"
if [ "$op" = stat ]; then head -c ${SNIFF_BYTES} < "./$n"; exit 0; fi
[ "$s" -le "$4" ] || exit 5
exec cat < "./$n"`;

class MachineFileRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const refusal = (status: number, code: string, message: string) => new MachineFileRefusal(status, code, message);
const unsupported = (message: string) => refusal(501, "unsupported", message);

/** hc's refusal, or the line to it ending, in the words the app acts on (fileFailure.ts, the composer's paste). */
function hcRefusal(error: HcError, missing: { code: string; message: string }): MachineFileRefusal {
  switch (error.kind) {
    case "not_found": return refusal(404, missing.code, missing.message);
    case "finished": return refusal(409, "pane_finished", "that terminal has finished");
    case "invalid_params": return refusal(400, "invalid_request", error.message);
    case "unknown_method":
    case "needs_update": return unsupported("Update herdr-core on this PC and on that machine to reach its files from Ovis");
    case "spawn_failed": return unsupported("That machine has no /bin/sh to read its files with");
    case "timeout": return refusal(504, "machine_timeout", "that machine did not answer in time");
    case "machine_unknown":
    case "unavailable":
    case "closed":
    case "bad_hello":
    case "bad_frame": return refusal(503, "machine_unavailable", "herdr-core cannot reach that machine right now");
    default: return refusal(502, "machine_refused", `herdr-core refused: ${error.message}`);
  }
}

async function calling<T>(ask: () => Promise<T>, missing: { code: string; message: string }): Promise<T> {
  try { return await ask(); } catch (error) {
    throw error instanceof HcError ? hcRefusal(error, missing) : error;
  }
}

async function offered(hc: MachineHc, method: "machine.exec" | "terminal.put"): Promise<void> {
  const { methods } = await calling(() => hc.hello(), NOT_FOUND);
  if (!methods.includes(method)) throw unsupported("Update herdr-core on this PC to reach that machine's files from Ovis");
}

const NOT_FOUND = { code: "not_found", message: "no readable file at that path" };

/** The script's answer: its exit code and its NUL-terminated values; `cut` when hc kept only the first of them. */
async function run(hc: MachineHc, op: "list" | "stat" | "read", path: string, base: string | null): Promise<{ code: number | null; values: Buffer[]; cut: boolean }> {
  await offered(hc, "machine.exec");
  const ran = await calling(() => hc.call("machine.exec", {
    argv: ["/bin/sh", "-c", SCRIPT, "ovis-files", op, path, base ?? "", String(MACHINE_FILE_BYTES)],
    env: { LC_ALL: "C" }, timeout: EXEC_SECONDS,
  }, CALL_MS), NOT_FOUND);
  if (ran.timed_out) throw refusal(504, "machine_timeout", "that machine did not answer in time");
  const out = Buffer.from(ran.stdout, "base64");
  const values: Buffer[] = [];
  let start = 0;
  for (let end = out.indexOf(0); end !== -1; end = out.indexOf(0, start)) {
    values.push(out.subarray(start, end));
    start = end + 1;
  }
  // what follows the last NUL: the file's own bytes, or a value cut short
  values.push(out.subarray(start));
  return { code: ran.code ?? null, values, cut: ran.truncated };
}

/** GET /api/workspace/directories there (shared/directories.ts), without making a folder. */
async function listFolder(hc: MachineHc, path: string, hidden: boolean, withFiles: boolean, base: string | null): Promise<Response> {
  const { code, values, cut } = await run(hc, "list", path.trim(), base);
  if (code === 2 || code === 3) return badRequest("invalid_cwd", "path must be a directory this user can read");
  if (code !== 0 || values.length < 3) throw refusal(502, "machine_refused", "that machine did not list the folder");
  const [home, target, ...entries] = values.map((value) => value.toString("utf8"));
  // the last value had no NUL: empty, or an entry hc cut short
  entries.pop();
  const directories: string[] = [];
  const files: { name: string; size: number }[] = [];
  for (const entry of entries) {
    const [type, size, ...name] = entry.split(" ");
    const named = name.join(" ");
    if (named === "" || (!hidden && named.startsWith("."))) continue;
    if (type === "d") directories.push(named);
    else if (type === "f") files.push({ name: named, size: Number(size) || 0 });
  }
  return jsonResponse(directoryListing(target!, home!, directories, withFiles ? files : null, cut, posix.dirname));
}

/** The file there and its facts, `read`: with its bytes; null when there is no readable file at `path`. */
async function machineFile(hc: MachineHc, op: "stat" | "read", path: string, base: string | null): Promise<{ info: FileInfo; bytes: Buffer } | null> {
  const asked = path.trim();
  if (asked === "" || (base === null && !asked.startsWith("/") && asked !== "~" && !asked.startsWith("~/"))) return null;
  const { code, values, cut } = await run(hc, op, asked, base);
  if (code === 3 || code === 4) return null;
  if (code === 5 || cut) throw refusal(413, "file_too_large", `that machine's file is larger than the ${MACHINE_FILE_BYTES} bytes herdr-core carries at once`);
  if (code !== 0 || values.length < 4) throw refusal(502, "machine_refused", "that machine did not read the file");
  const [named, size, modified] = values.slice(0, 3).map((value) => value.toString("utf8"));
  const bytes = values.slice(3).reduce((all, value, index) => index === 0 ? value : Buffer.concat([all, Buffer.from([0]), value]));
  const mime = mimeOf(named!);
  const seconds = Number(modified);
  const info: FileInfo = {
    path: named!, name: posix.basename(named!), size: Number(size), modified: new Date(Number.isFinite(seconds) ? seconds * 1000 : 0).toISOString(),
    mime, kind: kindFrom(mime, () => bytes.subarray(0, SNIFF_BYTES)),
  };
  return { info, bytes };
}

/** GET/HEAD /api/fs/file there: the bytes as this PC's own are sent (`fileResponse`), a page as plain text. */
function sendFile(request: Request, info: FileInfo, bytes: Buffer, download: boolean): Response {
  const { headers, type } = fileHeaders(info, download);
  headers.set("content-type", type);
  headers.set("accept-ranges", "bytes");
  const range = request.method === "GET" ? byteRange(request.headers.get("range"), request.headers.has("if-range"), bytes.byteLength) : null;
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${bytes.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  const [start, end] = range ?? [0, bytes.byteLength - 1];
  headers.set("content-length", String(end - start + 1));
  if (range !== null) headers.set("content-range", `bytes ${start}-${end}/${bytes.byteLength}`);
  return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes.subarray(start, end + 1)), { status: range === null ? 200 : 206, headers });
}

/** POST /api/pane/image there: the image put beside the terminal (`terminal.put`), and the path it landed at. */
async function pasteImage(request: Request, hc: MachineHc): Promise<Response> {
  let payload: unknown;
  try { payload = JSON.parse(await readImageBody(request)); } catch (error) {
    if (error instanceof PasteImageError) throw error;
    return badRequest("invalid_json", "request body must be JSON");
  }
  if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
  const { pane_id: paneId, content_type: contentType, data_base64: dataBase64, name } = payload;
  if (typeof paneId !== "string" || !paneId.trim()) return badRequest("missing_pane_id", "pane_id is required");
  if ((contentType !== undefined && typeof contentType !== "string") || (dataBase64 !== undefined && typeof dataBase64 !== "string") || (name !== undefined && typeof name !== "string")) {
    return badRequest("invalid_image", "content_type, data_base64 and name must be strings");
  }
  const image = pastedImage({ contentType: contentType ?? "", dataBase64: dataBase64 ?? "", name }, HC_BYTES);
  const missing = { code: "pane_not_found", message: `pane ${paneId} not found` };
  // another machine's terminal is no pane here (adapter.ts paneIdOf): nothing is sent to it
  if (onOtherMachine(paneId)) throw refusal(404, missing.code, missing.message);
  await offered(hc, "terminal.put");
  const put = await calling(() => hc.call("terminal.put", { terminal: paneId, name: image.name, data: image.data.toString("base64") }, CALL_MS), missing);
  return jsonResponse({ ok: true, path: put.path });
}

/**
 * The routes of OTHER_MACHINE_FILES (dispatch.ts) read on that machine; null for the rest, which stay
 * refused. `paneCwd`: the folder of the pane a relative path belongs to, null when it cannot be read.
 */
export async function handleMachineFileRequest(request: Request, url: URL, pathname: string, hc: MachineHc, paneCwd: (paneId: string) => Promise<string | null>): Promise<Response | null> {
  const folderOf = async (): Promise<{ base: string | null; unread: boolean }> => {
    const paneId = url.searchParams.get("pane_id");
    const base = paneId ? await paneCwd(paneId) : null;
    return { base, unread: paneId !== null && paneId !== "" && base === null };
  };
  try {
    if (pathname === "/api/workspace/directories" && request.method === "GET") {
      const { base, unread } = await folderOf();
      const path = url.searchParams.get("path") ?? "";
      if (unread && path.trim() !== "" && !path.trim().startsWith("/") && !path.trim().startsWith("~")) return badRequest("invalid_cwd", "the pane a relative path belongs to is gone");
      return await listFolder(hc, path, url.searchParams.get("hidden") === "1", url.searchParams.get("files") === "1", base);
    }
    if (pathname === "/api/fs/stat" || pathname === "/api/fs/file") {
      if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
      if (crossSiteFileRead(request)) return jsonResponse({ error: { code: "cross_site", message: "A file is read from this app or opened in a tab, not loaded by another page" } }, 403);
      const { base, unread } = await folderOf();
      const path = url.searchParams.get("path") ?? "";
      const found = await machineFile(hc, pathname === "/api/fs/file" && request.method === "GET" ? "read" : "stat", path, base);
      if (found === null && unread && !path.trim().startsWith("/") && !path.trim().startsWith("~")) return jsonResponse({ error: { code: "pane_unknown", message: "the pane a relative path belongs to could not be read" } }, 404);
      if (found === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
      return pathname === "/api/fs/stat" ? jsonResponse(found.info) : sendFile(request, found.info, found.bytes, url.searchParams.get("download") === "1");
    }
    if (pathname === "/api/pane/image") {
      if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
      return await pasteImage(request, hc);
    }
  } catch (error) {
    if (error instanceof MachineFileRefusal || error instanceof PasteImageError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    throw error;
  }
  return null;
}
