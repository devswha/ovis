/**
 * The files an ssh config's Include lines name, read for the SSH tab's list (server/ssh-candidates.ts): only what
 * really is inside the home or ssh folder, within one budget of files, bytes, folder entries and matching work per
 * config. A file or folder is opened first and what was opened is checked, so nothing swapped in on the way after a
 * check stands in for it: Linux names the opened object itself (/proc/self/fd), macOS too (proc_pidfdinfo), and
 * Windows resolves a file's path again once open, which must still name the same object. A folder is listed through
 * its open descriptor, a bounded read at a time (glibc's getdents64, else libc's fdopendir and readdir: macOS, musl;
 * server/ssh-include-dir.ts), and what it matched is opened relative to that folder, still held (openat), never
 * through a path a swap could redirect. Without those calls (Windows) Bun has no descriptor-relative
 * listing, so a wildcard's folders are listed by path, which a swap after the check can redirect. Such a listing only
 * gives names: a name from a folder out of home can be listed (its file is still opened and checked), and a file can be
 * hidden. So every file reached that way comes back marked `unclaimed` (its hosts are listed but claim no Tailscale
 * PC), and the Include also leaves the unread marker after them, whatever the listing found, so no host whose options
 * were still unset there (any host after it) claims one either.
 */
import { close, constants, fstat, read } from "node:fs";
import { open, readdir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { constants as os } from "node:os";
import { promisify } from "node:util";
import { isAbsolute, relative, sep } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

import type { Included } from "./ssh-config.ts";
import { platformDirStream, streamEntries, type DirStream } from "./ssh-include-dir.ts";
import { matchComponent, parseComponent, type Token } from "./ssh-include-glob.ts";

/** an ssh config is a few kilobytes; past this it is not read on */
export const MAX_FILE_BYTES = 256 * 1024;
/** files every Include of one config together reads at most */
const MAX_INCLUDED_FILES = 64;
/** bytes every Include of one config together reads at most */
const MAX_INCLUDED_BYTES = 1024 * 1024;
/** folder entries every Include of one config together looks at, matching or not */
const MAX_SCANNED_ENTRIES = 1024;
/** characters every Include of one config together tries a pattern on */
const MAX_MATCH_STEPS = 1_000_000;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const FOLDER_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);

type Budget = { files: number; bytes: number; entries: number; steps: number };
/** a folder's names; "unread" for one left unlisted (out of reach, past the budget, or not listed safely); null for none there */
type Listing = string[] | "unread" | null;
/** something open: a FileHandle, or a descriptor openat answered */
type Handle = { readonly fd: number; close: () => Promise<void> };
/** a path, and where a listing reached it from: the folder it held open and the rest of the path below it */
type Entry = { path: string; base?: { fd: number; rest: string } };
const [fstatOf, readOf, closeOf] = [promisify(fstat), promisify(read), promisify(close)];

/** a regular file's text when it is at most `cap` bytes, read from the open descriptor; "folder" for one; null for anything else */
async function readHandle(fd: number, cap: number): Promise<string | "folder" | null> {
  const found = await fstatOf(fd);
  if (found.isDirectory()) return "folder";
  if (!found.isFile() || found.size > cap) return null;
  const buffer = Buffer.alloc(found.size);
  const { bytesRead } = await readOf(fd, buffer, 0, found.size, 0);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** A regular file's text when it is at most `cap` bytes; opened without blocking, so a FIFO never holds the list */
export async function readCapped(path: string, cap: number): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, READ_FLAGS);
    const text = await readHandle(handle.fd, cap);
    return text === "folder" ? null : text;
  } catch { return null; } finally { await handle?.close(); }
}

const inside = (path: string, roots: readonly string[]): boolean => roots.some((root) => {
  const rest = relative(root, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
});

/** whether the object open at `fd`, opened as `path`, really is inside `roots` */
async function openedInside(fd: number, path: string, roots: readonly string[]): Promise<boolean> {
  const platform = includeTestOnly.platform ?? process.platform;
  if (platform === "linux") return inside(await readlink(`/proc/self/fd/${fd}`), roots);
  // the kernel's name for what is open on macOS; a path resolved again elsewhere, which a swap between two looks could fool
  const real = platform === "darwin" ? streamListing()?.pathOf?.(fd) ?? null : await realpath(path);
  if (real === null) return false;
  const [opened, named] = await Promise.all([fstatOf(fd, { bigint: true }), stat(real, { bigint: true })]);
  return inside(real, roots) && opened.dev === named.dev && opened.ino === named.ino;
}

/**
 * An entry opened, links followed as ssh does, relative to the folder a listing held when it has one, when what was
 * opened is inside `roots`; null when nothing is there
 */
async function openInside({ path, base }: Entry, roots: readonly string[], flags: number): Promise<Handle | "refused" | null> {
  const stream = streamListing();
  let handle: Handle;
  if (base !== undefined && stream !== null) {
    const fd = stream.openAt(base.fd, base.rest, flags);
    if (fd < 0) return -fd === os.errno.ENOENT || -fd === os.errno.ENOTDIR ? null : "refused";
    handle = { fd, close: () => closeOf(fd) };
  } else {
    try { handle = await open(path, flags); } catch (error) {
      // only a path that is not there is nothing, as for ssh; one it could not open (EACCES, EMFILE, ELOOP) is unread
      return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? null : "refused";
    }
  }
  if (await openedInside(handle.fd, path, roots).catch(() => false)) return handle;
  await handle.close();
  return "refused";
}

/** getdents64(2): fills `buffer` with a folder's entries from its descriptor and answers the bytes written, or -1 */
type Getdents = (fd: number, buffer: Buffer, length: number) => number | bigint;

/**
 * glibc's getdents64(2), which reads a folder's entries from its descriptor a buffer at a time; null without glibc. It is
 * called synchronously through bun:ffi, so a folder on a stalled network mount (an NFS or SMB home) blocks the server's
 * event loop, every request with it, until the mount answers, while the SSH list is built.
 */
const getdents: Getdents | null = (() => {
  if (process.platform !== "linux") return null;
  try { return dlopen("libc.so.6", { getdents64: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 } }).symbols.getdents64; } catch { return null; }
})();

/** libc's openat, and its fdopendir and readdir where getdents64 is not there; null without them (Windows) */
const dirStream: DirStream | null = platformDirStream();

/** whether a wildcard Include's folders are listed through their descriptor; without it, by path, unclaimed */
export const wildcardIncludesRead = getdents !== null || dirStream !== null;

/**
 * for tests only: getdents64 and fdopendir/readdir stood in for (a fake, or null for a platform without it), and the
 * platform openedInside checks on
 */
export const includeTestOnly: { getdents?: Getdents | null; dirStream?: DirStream | null; platform?: NodeJS.Platform } = {};
const descriptorListing = (): Getdents | null => includeTestOnly.getdents === undefined ? getdents : includeTestOnly.getdents;
const streamListing = (): DirStream | null => includeTestOnly.dirStream === undefined ? dirStream : includeTestOnly.dirStream;

/**
 * The names in a folder open at `fd`, each one charged to `budget.entries`; "unread" once it runs out, when getdents64
 * fails, or when what it answers is not well formed (a byte count past the buffer, a record that is empty, runs past
 * the bytes answered, or holds no terminated name)
 */
function entriesOf(fd: number, read: Getdents, budget: Budget): Listing {
  const buffer = Buffer.alloc(32 * 1024);
  const names: string[] = [];
  for (;;) {
    const got = Number(read(fd, buffer, buffer.byteLength));
    if (!Number.isInteger(got) || got < 0 || got > buffer.byteLength) return "unread";
    if (got === 0) return names;
    // struct linux_dirent64: d_ino (8), d_off (8), d_reclen (2), d_type (1), then the name and its NUL
    for (let at = 0; at < got;) {
      if (at + 20 > got) return "unread";
      const length = buffer.readUInt16LE(at + 16);
      const end = buffer.indexOf(0, at + 19);
      if (length < 20 || at + length > got || end <= at + 19 || end >= at + length) return "unread";
      const name = buffer.toString("utf8", at + 19, end);
      // a name whose bytes are not UTF-8 cannot be opened by the name decoded: what that file sets is unknown
      if (!Buffer.from(name).equals(buffer.subarray(at + 19, end))) return "unread";
      at += length;
      // every record counts against the budget, `.` and `..` too
      if (budget.entries-- <= 0) return "unread";
      if (name === "." || name === "..") continue;
      names.push(name);
    }
  }
}

/**
 * The names in folder `dir` when it really is inside `roots`: through its open descriptor where getdents64 or
 * fdopendir is, the folder then `held` open (the caller closes it) where openat is, else by the path its realpath
 * checked, read whole (Bun has no listing that stops early) and then charged to `budget.entries`
 */
async function listInside(dir: Entry, roots: readonly string[], budget: Budget): Promise<{ names: Listing; held?: Handle }> {
  const [getdentsCall, stream] = [descriptorListing(), streamListing()];
  const list = getdentsCall !== null ? (fd: number) => entriesOf(fd, getdentsCall, budget) : stream !== null ? (fd: number) => streamEntries(fd, stream, budget) : null;
  if (list !== null) {
    const folder = await openInside(dir, roots, FOLDER_FLAGS);
    if (folder === null) return { names: null };
    if (folder === "refused") return { names: "unread" };
    let names: Listing;
    try { names = list(folder.fd); } catch (error) { await folder.close(); throw error; }
    if (stream !== null && Array.isArray(names)) return { names, held: folder };
    await folder.close();
    return { names };
  }
  const real = await realpath(dir.path).catch(() => null);
  if (real === null) return { names: null };
  if (!inside(real, roots)) return { names: "unread" };
  // Bun has no listing that stops early: opendir's first read loads the whole folder too, and it ignores a buffer
  // encoding (so a name that is not UTF-8 could not be told apart); readdir is used, and a folder past the budget is unread
  let raw: Buffer[];
  try { raw = await readdir(real, { encoding: "buffer" }); } catch (error) {
    // a match that is a file (`conf.d/*/x`) or gone is nothing, as for ssh; a folder it could not list is unread
    return { names: error instanceof Error && "code" in error && (error.code === "ENOTDIR" || error.code === "ENOENT") ? null : "unread" };
  }
  const names = raw.map((bytes) => bytes.toString("utf8"));
  if (names.length > budget.entries || names.some((name, at) => !Buffer.from(name).equals(raw[at]!))) return { names: "unread" };
  budget.entries -= names.length;
  return { names };
}

/** `name` below an entry, reached from the same held folder */
const under = ({ path, base }: Entry, name: string): Entry => ({ path: `${path}${sep}${name}`, ...(base ? { base: { fd: base.fd, rest: `${base.rest}/${name}` } } : {}) });

/**
 * The files an Include pattern names: relative to `sshDir` as ssh reads the user config, `~` for the home folder. A
 * wildcard is walked one component at a time from the folder before it, each folder listed only when it is inside the
 * home or ssh folder; matches keep the spelling the pattern gives them and glob(3)'s order. A file ssh would read that is
 * left unread (out of those folders, past a budget, behind a pattern not matched exactly here, `~user`, a `%` token or
 * `${VAR}`, not a regular file of at most the size cap) comes back as null, so what it might set stays unknown; a file
 * that is not there is nothing, as for ssh. A file reached through a folder listed by path comes back `unclaimed`.
 */
export function includer(sshDir: string, home: string): (pattern: string) => Promise<Included[]> {
  const roots = Promise.all([sshDir, home].map((root) => realpath(root).catch(() => null)));
  const budget: Budget = { files: MAX_INCLUDED_FILES, bytes: MAX_INCLUDED_BYTES, entries: MAX_SCANNED_ENTRIES, steps: MAX_MATCH_STEPS };
  const escapes = sep === "/";
  return async (pattern) => {
    if (budget.files <= 0 || budget.bytes <= 0) return [null];
    // ssh expands `%` tokens, `${VAR}` and `~user` in an Include, which this offline reading does not
    if (/%|\$\{/.test(pattern) || (pattern.startsWith("~") && !pattern.startsWith("~/") && pattern !== "~")) return [null];
    const allowed = (await roots).filter((root): root is string => root !== null);
    // put together, never normalized: `*/..` and a trailing `/` are glob(3)'s to read, through the folders matched
    const expanded = pattern === "~" || pattern.startsWith("~/") ? `${home}${sep}${pattern.slice(2)}` : isAbsolute(pattern) ? pattern : `${sshDir}${sep}${pattern}`;
    const parts = expanded.split(escapes ? "/" : /[\\/]/).map((part) => part === "" ? { name: "" } : parseComponent(part, escapes));
    if (parts.includes(null)) return [null];
    const components = parts.filter((part): part is { name: string } | { tokens: Token[] } => part !== null);
    const first = components.findIndex((part) => "tokens" in part);
    const literal = (upTo: number) => components.slice(0, upTo).map((part) => "name" in part ? part.name : "").join(sep) || sep;
    // a scan cut short, or a folder left unlisted, may have missed a file sorted before the ones found
    let [scanCut, truncated] = [false, false];
    // the folders the last wildcard listed, held open until what they matched is opened
    let held: Handle[] = [];
    try {
      let paths: Entry[] = [];
      if (first < 0) paths = [{ path: literal(components.length) }];
      else {
        let level: Entry[] = [{ path: literal(first) }];
        for (const component of components.slice(first)) {
          const next: Entry[] = [];
          const opened: Handle[] = [];
          for (const dir of level) {
            if ("name" in component) { next.push(under(dir, component.name)); continue; }
            const { names, held: folder } = await listInside(dir, allowed, budget);
            if (folder !== undefined) opened.push(folder);
            if (names === "unread") { scanCut = true; continue; }
            for (const name of names ?? []) {
              const matched = matchComponent(component.tokens, name, budget);
              if (matched === null || (matched && next.length >= budget.files)) { scanCut = true; break; }
              if (matched) next.push({ path: `${dir.path}${sep}${name}`, ...(folder ? { base: { fd: folder.fd, rest: name } } : {}) });
            }
          }
          if ("tokens" in component) {
            await Promise.all(held.map((folder) => folder.close()));
            held = opened;
          }
          level = next;
        }
        // ssh reads the files glob(3) returns, sorted by their spelling's bytes (strcmp)
        paths = level.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
      }
      const byPath = first >= 0 && descriptorListing() === null && streamListing() === null;
      const texts: Included[] = [];
      for (const entry of paths) {
        if (budget.files <= 0 || budget.bytes <= 0) { truncated = true; break; }
        const handle = await openInside(entry, allowed, READ_FLAGS);
        if (handle === null) continue;
        if (handle === "refused") { texts.push(null); continue; }
        try {
          const found = await readHandle(handle.fd, Math.min(MAX_FILE_BYTES, budget.bytes)).catch(() => null);
          // a folder among a wildcard's matches is no config, as for ssh
          if (found === "folder" && first >= 0) continue;
          budget.files--;
          const text = found === "folder" ? null : found;
          if (text !== null) budget.bytes -= Buffer.byteLength(text);
          texts.push(text === null || !byPath ? text : { text, unclaimed: true });
        } finally { await handle.close(); }
      }
      return [...(scanCut ? [null] : []), ...texts, ...(truncated || byPath ? [null] : [])];
    } finally { await Promise.all(held.map((folder) => folder.close())); }
  };
}
