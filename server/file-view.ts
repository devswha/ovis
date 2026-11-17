import { randomBytes } from "node:crypto";
import { type BigIntStats, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, read, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, type PlatformPath, relative as relativePath, resolve, sep } from "node:path";

import type { FileInfo, FileKind } from "../shared/protocol.ts";
import { pagePolicy } from "../shared/web-policy.ts";
import { fileTask } from "./file-pool.ts";
import type { OpenedFile, RenderedPage } from "./file-tasks.ts";
import { filesNamed } from "./files.ts";
import { jsonResponse } from "./http.ts";
import { otherHostsShare } from "./windows-share.ts";

export { pagePolicy };


export function resolveFilePath(input: string, cwd: string | null, rules: Pick<PlatformPath, "resolve" | "isAbsolute" | "sep"> = { resolve, isAbsolute, sep }, home = homedir()): string | null {
  const path = input.trim();
  if (path === "") return null;
  const resolved = path === "~" ? home : path.startsWith("~/") ? rules.resolve(home, path.slice(2)) : rules.isAbsolute(path) ? rules.resolve(path) : cwd === null ? null : rules.resolve(cwd, path);
  if (resolved === null) return null;
  // read after it is resolved, as Windows will read it: `~///host/share` and `/\\host/share` are shares only then
  return rules.sep === "\\" && otherHostsShare(resolved, [cwd === null ? null : rules.resolve(cwd), rules.resolve(home), rules.resolve(".")]) ? null : resolved;
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|typescript|xml|x-sh|toml|yaml|x-yaml|sql)|image\/svg\+xml)/;
const SNIFF_BYTES = 8192;

function kindOf(mime: string, path: string, opened: number | null = null): FileKind {
  if (mime === "image/svg+xml") return "image";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (TEXT_TYPES.test(mime)) return "text";
  let fd: number | null = null;
  try {
    if (opened === null) fd = openSync(path, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(opened ?? fd!, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0) ? "binary" : "text";
  } catch {
    return "binary";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const MAX_NAME_MATCHES = 10;

/** The same visible name may be stored composed or decomposed, one folder at a time. */
export function pathsByName(path: string): string[] {
  if (!/[^\x00-\x7f]/.test(path)) return [];
  const root = parse(path).root;
  let paths = [root];
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    const next: string[] = [];
    for (const dir of paths) {
      const exact = join(dir, part);
      if (existsSync(exact)) {
        next.push(exact);
        continue;
      }
      if (!/[^\x00-\x7f]/.test(part)) continue;
      try {
        for (const name of readdirSync(dir)) {
          if (name.normalize("NFC") === part.normalize("NFC")) next.push(join(dir, name));
        }
      } catch { }
    }
    paths = next.sort().slice(0, MAX_NAME_MATCHES);
    if (paths.length === 0) return [];
  }
  return paths;
}

export async function locateFile(input: string, cwd: string | null, anyForm = false): Promise<{ info: FileInfo } | { candidates: string[] } | null> {
  const path = resolveFilePath(input, cwd);
  const info = anyForm || path === null ? null : await fileTask<FileInfo | null>({ op: "info", path });
  if (info !== null) return { info };
  if (anyForm && path !== null) {
    const matches = await fileTask<FileInfo[]>({ op: "named", path });
    if (matches.length === 1) return { info: matches[0]! };
    if (matches.length > 1) return { candidates: matches.map((match) => match.path) };
  }
  const relative = input.trim();
  if (cwd === null || relative === "" || isAbsolute(relative) || relative.startsWith("~") || relative.startsWith("../")) return null;
  if (anyForm && !/[^\x00-\x7f]/.test(relative)) return null;
  const found = (await filesNamed(cwd, relative, 10, anyForm)).map((match) => resolve(cwd, match));
  if (found.length === 1) {
    const only = await fileTask<FileInfo | null>({ op: "info", path: found[0]! });
    return only === null ? null : { info: only };
  }
  return found.length > 1 ? { candidates: found } : null;
}

export type LocatedFile = { info: FileInfo; within?: string } | { candidates: string[] } | null;

export async function locateFileInFolder(input: string, folder: string, anyForm = false, walk = true): Promise<LocatedFile> {
  const relative = input.trim();
  if (isAbsolute(relative) || relative.startsWith("~") || !resolve(folder, relative).startsWith(resolve(folder) + sep)) return null;
  const found = walk ? await locateFile(relative, folder, anyForm) : await locateFile(resolve(folder, relative), null, anyForm);
  if (found === null) return null;
  if ("candidates" in found) return await fileTask<boolean>({ op: "within", paths: found.candidates, folder }) ? found : null;
  return await fileTask<{ info: FileInfo; within: string } | null>({ op: "describe", path: found.info.path, folder });
}

export function describeWithin(path: string, folder: string, cell?: Int32Array<SharedArrayBuffer>): { info: FileInfo; within: string } | null {
  let within: string;
  try { within = realpathSync(folder); } catch { return null; }
  const file = openAuthorized(path, [within], true, cell);
  if (file === null) return null;
  try {
    const mime = mimeOf(path);
    const modified = fstatSync(file.fd).mtime.toISOString();
    return { info: { path, name: basename(path), size: file.size, modified, mime, kind: kindOf(mime, path, file.fd) }, within };
  } catch { return null; } finally {
    if (cell === undefined || Atomics.compareExchange(cell, 0, file.fd, -1) === file.fd) release(file.fd);
  }
}

export async function findFile(input: string, cwd: string | null, scratchFolder: () => Promise<string | null>, mayBeScratch: (path: string) => boolean = () => false): Promise<LocatedFile> {
  let asked: Promise<string | null> | undefined;
  const scratchOnce = () => asked ??= scratchFolder();
  const inScratch = async (path: string | null): Promise<{ folder: string; relative: string } | null> => {
    if (path === null || !mayBeScratch(path)) return null;
    const folder = await scratchOnce();
    return folder !== null && path.startsWith(resolve(folder) + sep) ? { folder, relative: relativePath(resolve(folder), path) } : null;
  };
  const named = await inScratch(resolveFilePath(input, cwd));
  if (named !== null) {
    const walk = !isAbsolute(input.trim()) && !input.trim().startsWith("~");
    return await locateFileInFolder(named.relative, named.folder, false, walk) ?? locateFileInFolder(named.relative, named.folder, true, walk);
  }
  const exact = await locateFile(input, cwd);
  const walked = exact !== null && "info" in exact ? await inScratch(exact.info.path) : null;
  if (walked !== null) return locateFileInFolder(walked.relative, walked.folder);
  if (exact !== null) return exact;
  let folder: string | null = null;
  if (cwd !== null && !isAbsolute(input.trim()) && !input.trim().startsWith("~")) {
    folder = await scratchOnce();
    if (folder !== null) {
      const scratch = await locateFileInFolder(input, folder);
      if (scratch !== null) return scratch;
    }
  }
  const found = await locateFile(input, cwd, true);
  if (found !== null) return found;
  return folder === null ? null : locateFileInFolder(input, folder, true);
}

export function fileInfo(path: string): FileInfo | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mime = Bun.file(path).type.split(";")[0] || "application/octet-stream";
  return { path, name: basename(path), size: stat.size, modified: stat.mtime.toISOString(), mime, kind: kindOf(mime, path) };
}

const EMBED_FILE_BYTES = 8 * 1024 * 1024;
const EMBED_TOTAL_BYTES = 32 * 1024 * 1024;
const EMBED_PAGE_BYTES = 8 * 1024 * 1024;
const EMBED_REFS = 1_000;

export const PAGE_MEDIA_PATH = "/api/fs/page-media/";
export const PAGE_MEDIA_ROUTE = /^\/api\/fs\/page-media\/[A-Za-z0-9_-]{32}$/;
export const PAGE_MEDIA_LIFETIME_MS = 30 * 60 * 1000;
const PAGE_MEDIA_ADDRESSES = 4_096;
export const PAGE_MEDIA_PER_RENDER = 50;
export interface PageMediaOwner { client: string | null; device: string | null }
export interface PageMedia extends PageMediaOwner { source: string }
export interface PageMediaEntry extends PageMediaOwner { requested: string; roots: readonly string[]; mime: string; expires: number; dev: bigint; ino: bigint; size: number; mtimeNs: bigint }
const pageMediaFiles = new Map<string, PageMediaEntry>();

export type PageMediaGrant = [token: string, entry: PageMediaEntry];

function grantPageMedia(file: Authorized, owner: PageMediaOwner, now = Date.now()): PageMediaGrant {
  return [randomBytes(24).toString("base64url"), { requested: file.requested, roots: file.roots, mime: file.mime, expires: now + PAGE_MEDIA_LIFETIME_MS, dev: file.dev, ino: file.ino, size: file.size, mtimeNs: file.mtimeNs, client: owner.client, device: owner.device }];
}

type MediaOwnerKey = { device: string } | { client: string | null };
const ownedBy = (entry: PageMediaOwner, owner: MediaOwnerKey): boolean => "device" in owner ? entry.device === owner.device : entry.client === owner.client;

let forgets = 0;
const forgotten: { at: number; owner: MediaOwnerKey }[] = [];
const watching = new Map<number, number>();

function pruneForgotten(): void {
  const oldest = watching.size === 0 ? forgets : Math.min(...watching.keys());
  while (forgotten.length > 0 && forgotten[0]!.at <= oldest) forgotten.shift();
}

export function watchPageMedia(): { since: number; done: () => void } {
  const since = forgets;
  watching.set(since, (watching.get(since) ?? 0) + 1);
  let ended = false;
  return {
    since,
    done: () => {
      if (ended) return;
      ended = true;
      const left = watching.get(since)! - 1;
      if (left === 0) watching.delete(since);
      else watching.set(since, left);
      pruneForgotten();
    },
  };
}

export function keepPageMedia(grants: readonly PageMediaGrant[], now = Date.now(), since = forgets): void {
  for (const [token, entry] of grants) {
    if (forgotten.some((forget) => forget.at > since && ownedBy(entry, forget.owner))) continue;
    for (const [old, kept] of pageMediaFiles) {
      if (kept.expires > now && pageMediaFiles.size < PAGE_MEDIA_ADDRESSES) break;
      pageMediaFiles.delete(old);
    }
    pageMediaFiles.set(token, entry);
  }
}

export function forgetPageMedia(owner: MediaOwnerKey): void {
  forgets += 1;
  forgotten.push({ at: forgets, owner });
  pruneForgotten();
  for (const [token, entry] of pageMediaFiles) {
    if (ownedBy(entry, owner)) pageMediaFiles.delete(token);
  }
}

export function pageMediaSource(host: string | null, secure: boolean, forwardedHost: string | null = null): string | null {
  const asked = forwardedHost?.split(",")[0]?.trim() || host;
  if (asked === null || !/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(asked)) return null;
  return `${secure ? "https" : "http"}://${asked}${PAGE_MEDIA_PATH}`;
}

export function pageMediaResponse(token: string, client: string | null, request: Request | null = null, now = Date.now()): Response | null {
  const entry = pageMediaFiles.get(token);
  if (entry === undefined) return null;
  if (entry.expires <= now) {
    pageMediaFiles.delete(token);
    return null;
  }
  if (entry.client !== client) return null;
  const file = openAuthorized(entry.requested, entry.roots);
  if (file === null) return null;
  if (file.dev !== entry.dev || file.ino !== entry.ino || file.size !== entry.size || file.mtimeNs !== entry.mtimeNs) {
    release(file.fd);
    return null;
  }
  const headers = new Headers({
    "content-type": entry.mime,
    "accept-ranges": "bytes",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "sandbox; default-src 'none'",
  });
  // RFC 9110 defines a range for GET alone: a HEAD describes the whole file
  const range = request?.method === "GET" ? byteRange(request.headers.get("range"), request.headers.has("if-range"), file.size) : null;
  if (range === "unsatisfiable") {
    release(file.fd);
    headers.set("content-range", `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  const [start, end] = range ?? [0, file.size - 1];
  headers.set("content-length", String(end - start + 1));
  if (range !== null) headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
  const status = range === null ? 200 : 206;
  if (request?.method === "HEAD") {
    release(file.fd);
    return new Response(null, { status, headers });
  }
  return new Response(descriptorBody(file.fd, start, end - start + 1, file), { status, headers });
}

/**
 * The one range a `Range` header asks for, inclusive, within `size` bytes (RFC 9110 section 14):
 * null for the whole file, which is the answer to no header, to one that comes with `If-Range`
 * (this answer names no validator it could match), and to one this server does not serve (another
 * unit, several ranges, one it cannot read); "unsatisfiable" for a range that starts past the end.
 * An end past the last byte means the last byte.
 */
export function byteRange(header: string | null, ifRange: boolean, size: number): [number, number] | "unsatisfiable" | null {
  if (header === null || ifRange || size === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (match === null) return null;
  const [first, last] = [match[1]!, match[2]!];
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0 ? "unsatisfiable" : [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) return "unsatisfiable";
  return [start, last === "" ? size - 1 : Math.min(Number(last), size - 1)];
}

export const STREAM_CHUNK_BYTES = 256 * 1024;

function descriptorBody(fd: number, start: number, length: number, unchanged: { size: number; mtimeNs: bigint } | null): ReadableStream<Uint8Array> {
  let position = start;
  let left = length;
  let reading = false;
  let cancelled = false;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    release(fd);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (left === 0) {
        finish();
        controller.close();
        return;
      }
      const buffer = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, left));
      reading = true;
      let read: number;
      try {
        read = await (pageFileHooks.read ?? readAt)(fd, buffer, position);
        if (read === 0) throw new Error("the file ended before it was read");
        if (unchanged !== null) {
          const now = (pageFileHooks.fstat ?? fstatBig)(fd);
          if (now.size !== BigInt(unchanged.size) || now.mtimeNs !== unchanged.mtimeNs) throw new Error("the file changed while it was read");
        }
      } catch (error) {
        reading = false;
        finish();
        if (!cancelled) controller.error(error);
        return;
      }
      reading = false;
      if (cancelled) {
        finish();
        return;
      }
      position += read;
      left -= read;
      controller.enqueue(buffer.subarray(0, read));
      if (left === 0) {
        finish();
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      if (!reading) finish();
    },
  }, { highWaterMark: 0 });
}

const readAt = (fd: number, buffer: Buffer, position: number): Promise<number> => new Promise((done, fail) => {
  read(fd, buffer, 0, buffer.length, position, (error, bytes) => { if (error) fail(error); else done(bytes); });
});

function pageRelative(ref: string): string | null {
  const value = ref.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("\\") || value.startsWith("#")) return null;
  let relative: string;
  try { relative = decodeURIComponent(value.split(/[?#]/)[0]!); } catch { return null; }
  // decoded, it may name a root, a drive or a share (`%5C%5Chost%5Cshare`): on Windows, resolving
  // that would reach out to the share before any check, so it never gets that far
  if (!relative || isAbsolute(relative) || /^[\\/]/.test(relative) || /^[a-z]:/i.test(relative)) return null;
  return relative;
}

function pageTarget(ref: string, folder: string): string | null {
  const relative = pageRelative(ref);
  if (relative === null) return null;
  const target = resolve(folder, relative);
  return target.startsWith(folder + sep) ? target : null;
}

const hiddenBelow = (folder: string, path: string): boolean => path.slice(folder.length + 1).split(sep).some((part) => part.startsWith("."));

function rootOf(file: string, roots: readonly string[], hidden = false): string | undefined {
  const root = roots.find((candidate) => file.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep));
  if (root === undefined || (!hidden && hiddenBelow(root.endsWith(sep) ? root.slice(0, -1) : root, file))) return undefined;
  return root;
}

export const pageFileHooks: {
  platform?: NodeJS.Platform;
  uid?: () => number | undefined;
  pageFolder?: (folder: string) => void;
  pageOpened?: (fd: number) => void;
  afterResolve?: (file: string) => void;
  afterOpen?: (file: string) => void;
  beforeIdentity?: (file: string) => void;
  afterAuthorize?: (requested: string) => void;
  fstat?: (fd: number) => BigIntStats;
  readlink?: (path: string) => string;
  read?: (fd: number, buffer: Buffer, position: number) => Promise<number>;
  readSync?: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => number;
  fastDiskMs?: number;
  openFiles?: number | null;
  opened?: (fd: number) => void;
  closed?: (fd: number) => void;
} = {};

const fstatBig = (fd: number): BigIntStats => fstatSync(fd, { bigint: true });
/** O_NONBLOCK, so a FIFO put where a file was is not waited on; O_NOFOLLOW, so a link put there since the check is not followed. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

export function release(fd: number): void {
  closeSync(fd);
  pageFileHooks.closed?.(fd);
}

export interface Authorized { fd: number; requested: string; file: string; roots: readonly string[]; mime: string; dev: bigint; ino: bigint; size: number; mtimeNs: bigint }

export function openAuthorized(requested: string, roots: readonly string[], hidden = false, cell?: Int32Array<SharedArrayBuffer>): Authorized | null {
  const hooks = pageFileHooks;
  let file: string;
  try {
    file = realpathSync(requested);
    if (rootOf(file, roots, hidden) === undefined || !statSync(file).isFile()) return null;
  } catch { return null; }
  hooks.afterResolve?.(file);
  let fd: number;
  try { fd = openSync(file, OPEN_FLAGS); } catch { return null; }
  if (cell !== undefined) Atomics.store(cell, 0, fd);
  hooks.opened?.(fd);
  let kept = false;
  try {
    const opened = (hooks.fstat ?? fstatBig)(fd);
    if (!opened.isFile() || opened.ino === 0n) return null;
    hooks.afterOpen?.(file);
    const again = realpathSync(requested);
    const root = rootOf(again, roots, hidden);
    if (root === undefined) return null;
    hooks.beforeIdentity?.(again);
    const named = statSync(again, { bigint: true });
    if (named.dev !== opened.dev || named.ino !== opened.ino) return null;
    if (!openedWithin(fd, again, root, roots, hidden)) return null;
    hooks.afterAuthorize?.(requested);
    const settled = (hooks.fstat ?? fstatBig)(fd);
    if (settled.dev !== opened.dev || settled.ino !== opened.ino || settled.size !== opened.size || settled.mtimeNs !== opened.mtimeNs) return null;
    kept = true;
    return { fd, requested, file: again, roots, mime: mimeOf(again), dev: opened.dev, ino: opened.ino, size: Number(opened.size), mtimeNs: opened.mtimeNs };
  } catch {
    return null;
  } finally {
    if (!kept && (cell === undefined || Atomics.compareExchange(cell, 0, fd, -1) === fd)) release(fd);
  }
}

function openedWithin(fd: number, file: string, root: string, roots: readonly string[], hidden = false): boolean {
  const platform = pageFileHooks.platform ?? process.platform;
  if (platform === "linux") {
    let opened: string;
    try { opened = (pageFileHooks.readlink ?? readlinkSync)(`/proc/self/fd/${fd}`); } catch { return false; }
    return !opened.endsWith(" (deleted)") && rootOf(opened, roots, hidden) !== undefined;
  }
  if (platform === "darwin") return ownedFolders(root, file, pageFileHooks.uid ? pageFileHooks.uid() : process.getuid?.());
  return platform === "win32";
}

function pageOpenedAs(fd: number, file: string, opened: BigIntStats): boolean {
  if ((pageFileHooks.platform ?? process.platform) === "linux") {
    let path: string;
    try { path = (pageFileHooks.readlink ?? readlinkSync)(`/proc/self/fd/${fd}`); } catch { return false; }
    return path === file;
  }
  const named = lstatSync(file, { bigint: true });
  return named.isFile() && named.dev === opened.dev && named.ino === opened.ino && realpathSync(file) === file;
}

export function ownedFolders(root: string, file: string, uid: number | undefined): boolean {
  if (uid === undefined) return false;
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  const below = dirname(file).slice(base.length).split(sep).filter(Boolean);
  let folder = base === "" ? sep : base;
  for (let index = 0; ; index += 1) {
    let stat;
    try { stat = lstatSync(folder); } catch { return false; }
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) return false;
    if (index === below.length) return true;
    folder = join(folder, below[index]!);
  }
}

function mediaRoots(): string[] {
  const roots: string[] = [];
  for (const entry of (process.env["OVIS_MEDIA_ROOTS"] ?? "").split(delimiter)) {
    const path = entry.trim();
    if (!path || !isAbsolute(path)) continue;
    try { roots.push(realpathSync(path)); } catch { }
  }
  return roots;
}

function pageStreamTarget(ref: string, folder: string, roots: readonly string[]): string | null {
  const relative = pageRelative(ref);
  if (relative === null || relative.split(/[\\/]/).some((part) => part.startsWith(".") && part !== "." && part !== "..")) return null;
  const target = resolve(folder, relative);
  return target.startsWith(folder + sep) || roots.length > 0 ? target : null;
}

const mimeOf = (file: string): string => Bun.file(file).type.split(";")[0] || "application/octet-stream";
const MEDIA = (mime: string) => /^(?:image|video|audio)\//.test(mime);
const PLAYS = (mime: string) => /^(?:video|audio)\//.test(mime);
const SCRIPT = (mime: string) => mime === "text/javascript" || mime === "application/javascript";
const STYLE = (mime: string) => mime === "text/css";
const RUNS = (type: string | null) => type === null || /^\s*(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)?\s*$/i.test(type);

function readWhole(fd: number, size: number, mtimeNs: bigint): Buffer | null {
  const buffer = Buffer.alloc(size);
  for (let at = 0; at < size;) {
    const read = readSync(fd, buffer, at, size - at, at);
    if (read === 0) return null;
    at += read;
  }
  const after = (pageFileHooks.fstat ?? fstatBig)(fd);
  return after.size === BigInt(size) && after.mtimeNs === mtimeNs ? buffer : null;
}

interface PageAsset { target: string; mime: string; size: number; data: string | null }

export function pageWithLocalFiles(path: string, media: PageMedia | null = null, grant: (given: PageMediaGrant) => void = (given) => keepPageMedia([given]), within: string | null = null): string | null {
  let file: string;
  try { file = realpathSync(path); } catch { return null; }
  if (within !== null && rootOf(file, [within], true) === undefined) return null;
  const folder = dirname(file);
  pageFileHooks.pageFolder?.(folder);
  let html: string;
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  pageFileHooks.pageOpened?.(fd);
  try {
    const page = fstatBig(fd);
    if (!page.isFile() || page.size > BigInt(EMBED_PAGE_BYTES) || !pageOpenedAs(fd, file, page)) return null;
    if (within !== null && !openedWithin(fd, file, within, [within], true)) return null;
    if (realpathSync(path) !== file) return null;
    const bytes = readWhole(fd, Number(page.size), page.mtimeNs);
    if (bytes === null) return null;
    html = bytes.toString("utf8");
  } catch {
    return null;
  } finally { closeSync(fd); }
  let left = EMBED_TOTAL_BYTES;
  const resolved = new Map<string, PageAsset | null>();
  const streamed = new Map<string, string | null>();
  const roots = media !== null ? mediaRoots() : [];
  const addresses = new Map<string, string | null>();
  let granted = 0;
  const lookups = () => resolved.size + streamed.size;
  const asset = (target: string, accepts: (mime: string) => boolean): PageAsset | null => {
    const file = openAuthorized(target, [folder]);
    if (file === null) return null;
    try {
      const found: PageAsset = { target, mime: file.mime, size: file.size, data: null };
      if (!accepts(file.mime) || file.size > EMBED_FILE_BYTES || file.size > left) return found;
      const bytes = readWhole(file.fd, file.size, file.mtimeNs);
      if (bytes === null) return null;
      found.data = bytes.toString("base64");
      return found;
    } finally { release(file.fd); }
  };
  const take = (ref: string | null, accepts: (mime: string) => boolean): PageAsset | null => {
    if (ref === null) return null;
    if (!resolved.has(ref)) {
      const target = lookups() < EMBED_REFS ? pageTarget(ref, folder) : null;
      resolved.set(ref, target === null ? null : asset(target, accepts));
    }
    let found = resolved.get(ref) ?? null;
    if (found === null || !accepts(found.mime) || found.size > EMBED_FILE_BYTES || found.size > left) return null;
    if (found.data === null) {
      found = asset(found.target, accepts);
      resolved.set(ref, found);
      if (found?.data == null) return null;
    }
    left -= found.size;
    return found;
  };
  const play = (ref: string, owner: PageMedia): string | null => {
    if (!streamed.has(ref)) {
      const target = lookups() < EMBED_REFS ? pageStreamTarget(ref, folder, roots) : null;
      const file = target === null ? null : openAuthorized(target, [folder, ...roots]);
      let address: string | null = null;
      if (file !== null) {
        try {
          if (PLAYS(file.mime)) {
            const key = `${file.dev}:${file.ino}`;
            if (!addresses.has(key)) {
              let token: string | null = null;
              if (granted < PAGE_MEDIA_PER_RENDER) {
                const given = grantPageMedia(file, owner);
                grant(given);
                token = given[0];
                granted += 1;
              }
              addresses.set(key, token === null ? null : owner.source + token);
            }
            address = addresses.get(key) ?? null;
          }
        } finally { release(file.fd); }
      }
      streamed.set(ref, address);
    }
    return streamed.get(ref) ?? null;
  };
  const embed = (attribute: string, accepts: (mime: string) => boolean, when: (element: HTMLRewriterTypes.Element) => boolean = () => true, streams = false) => ({
    element(element: HTMLRewriterTypes.Element) {
      if (!when(element)) return;
      const ref = element.getAttribute(attribute);
      const file = take(ref, accepts);
      if (file !== null) element.setAttribute(attribute, `data:${file.mime};base64,${file.data}`);
      else if (media !== null && streams && ref !== null) {
        const address = play(ref, media);
        if (address !== null) element.setAttribute(attribute, address);
      }
    },
  });
  return new HTMLRewriter()
    .on("img[src]", embed("src", MEDIA))
    .on("source[src]", embed("src", MEDIA, undefined, true))
    .on("video[src]", embed("src", MEDIA, undefined, true))
    .on("video[poster]", embed("poster", MEDIA))
    .on("audio[src]", embed("src", MEDIA, undefined, true))
    .on("script[src]", embed("src", SCRIPT, (element) => RUNS(element.getAttribute("type"))))
    .on('link[rel~="stylesheet" i][href]', embed("href", STYLE))
    .transform(html);
}

export function crossSiteFileRead(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === null || site === "same-origin" || site === "none") return false;
  return request.headers.get("sec-fetch-mode") !== "navigate";
}

export function isHtmlPage(info: FileInfo): boolean {
  return info.kind === "text" && info.mime === "text/html";
}

/**
 * Descriptors a file body names by `/proc/self/fd` (`fileResponse`), each closed once both that body
 * and its answer are collected: Bun opens the body's path only when it sends it, so the descriptor
 * must outlive that open, or its number could name another file by then; an answer or body still
 * held may still be sent.
 */
const bodyDescriptors = new FinalizationRegistry<{ fd: number; left: number }>((held) => {
  held.left -= 1;
  if (held.left > 0) return;
  bodiesHeld -= 1;
  try { release(held.fd); } catch { }
});
let bodiesHeld = 0;
let bodyCap: { most: number; collectPast: number } | null = null;
const bodyLimits = (): { most: number; collectPast: number } => {
  if (bodyCap !== null && pageFileHooks.openFiles === undefined) return bodyCap;
  const open = pageFileHooks.openFiles ?? openFileLimit();
  const most = open === null ? 256 : Math.min(32_768, Math.floor(open / 4));
  const cap = { most, collectPast: Math.min(256, Math.floor(most / 4)) };
  if (pageFileHooks.openFiles === undefined) bodyCap = cap;
  return cap;
};
const openFileLimit = (): number | null => {
  try {
    const line = readFileSync("/proc/self/limits", "utf8").split("\n").find((entry) => entry.startsWith("Max open files"));
    const soft = line?.trim().split(/\s+/)[3];
    if (soft === "unlimited") return Infinity;
    const limit = Number(soft);
    return Number.isFinite(limit) && limit > 0 ? limit : null;
  } catch { return null; }
};
const COLLECTION_MS = 250;
let collectionAsked = -Infinity;
/**
 * Past `collectPast` bodies held, most were sent long ago and only wait for a collection: one is
 * asked for on the collector's own threads (`Bun.gc(false)`). The collector may then collect only
 * what was made since the last collection, letting go of bodies sent since then (about half the
 * peak in a burst of downloads) and leaving ones that lived through a collection while they were
 * sent until a full one. Never a
 * forced one (`Bun.gc(true)`), which would let all of them go but stops every terminal and request
 * on this thread for as long as it takes on the whole heap; and at most once per `COLLECTION_MS`,
 * so a player that really holds many does not ask on every answer.
 */
const askCollection = () => {
  const now = performance.now();
  if (now - collectionAsked < COLLECTION_MS) return;
  collectionAsked = now;
  Bun.gc(false);
};

export const FILE_POLICY = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

export async function fileResponse(info: FileInfo, download: boolean, render = false, media: PageMedia | null = null, request: Request | null = null, watched?: ReturnType<typeof watchPageMedia>, within: string | null = null, stream = false): Promise<Response> {
  const name = encodeURIComponent(info.name);
  const headers = new Headers({
    "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  const page = render && !download && isHtmlPage(info);
  // a PDF is drawn by the browser's own viewer, which refuses a sandboxed document; its
  // scripts stay inside that viewer, never on this origin
  if (page) headers.set("content-security-policy", pagePolicy(media?.source ?? null));
  else if (info.kind !== "pdf") headers.set("content-security-policy", FILE_POLICY);
  const type = page ? "text/html; charset=utf-8" : info.kind === "text" && info.mime !== "image/svg+xml" ? "text/plain; charset=utf-8" : info.mime;
  const gone = () => jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
  if (page && info.size <= EMBED_PAGE_BYTES) {
    const watch = media === null ? null : (watched ?? watchPageMedia());
    let rendered: RenderedPage;
    try {
      rendered = await fileTask<RenderedPage>({ op: "render", path: info.path, media, within }, request?.signal);
      if (rendered.html === null) return gone();
      if (watch !== null) keepPageMedia(rendered.grants, Date.now(), watch.since);
    } finally {
      if (watched === undefined) watch?.done();
    }
    headers.set("content-type", type);
    return new Response(rendered.html, { headers });
  }
  const head = request?.method === "HEAD";
  // RFC 9110 defines a range for GET alone: a HEAD describes the whole file
  const get = head ? null : { range: request?.method === "GET" ? request.headers.get("range") : null, ifRange: request?.headers.has("if-range") ?? false };
  // A Bun file body is sized/chunked by Bun.serve, which relay dispatch never enters. Its JS
  // reader may return the entire file at once, overflowing the mux's per-session buffer.
  // Keep the descriptor and use bounded reads for relay files, including their Content-Length.
  const opened = await fileTask<OpenedFile | null>({ op: "open", path: info.path, get, within, fastDiskMs: stream ? 0 : pageFileHooks.fastDiskMs }, request?.signal);
  if (opened === null) return gone();
  headers.set("content-type", type);
  headers.set("accept-ranges", "bytes");
  if (opened.range === "unsatisfiable") {
    headers.set("content-range", `bytes */${opened.size}`);
    return new Response(null, { status: 416, headers });
  }
  const [start, end] = opened.range ?? [0, opened.size - 1];
  const length = end - start + 1;
  headers.set("content-length", String(length));
  if (opened.range !== null) headers.set("content-range", `bytes ${start}-${end}/${opened.size}`);
  const status = opened.range === null ? 200 : 206;
  if (head) return new Response(null, { status, headers });
  if (opened.bytes !== null) return new Response(opened.bytes, { status, headers });
  if (opened.fast) {
    // a file body, which Bun sizes itself (and reads on this thread: its disk just answered at once);
    // a scratch file (`within`) by its descriptor's own path, the file that descriptor holds
    headers.delete("content-length");
    const limits = bodyLimits();
    if (opened.fd !== null && bodiesHeld >= limits.collectPast) askCollection();
    if (opened.fd !== null && bodiesHeld >= limits.most) {
      headers.set("content-length", String(length));
      return new Response(descriptorBody(opened.fd, start, length, null), { status, headers });
    }
    const body = Bun.file(opened.fd === null ? info.path : `/proc/self/fd/${opened.fd}`, { type }).slice(start, end + 1, type);
    const response = new Response(body, { status, headers });
    if (opened.fd !== null) {
      const held = { fd: opened.fd, left: 2 };
      bodiesHeld += 1;
      bodyDescriptors.register(body, held);
      bodyDescriptors.register(response, held);
    }
    return response;
  }
  return new Response(descriptorBody(opened.fd!, start, length, null), { status, headers });
}
