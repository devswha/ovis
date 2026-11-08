/**
 * The files an ssh config's Include lines name, read for the SSH tab's list (server/ssh-candidates.ts): only what
 * really is inside the home or ssh folder, within one budget of files, bytes, folder entries and matching work per
 * config. A file or folder is opened first and what was opened is checked, so nothing swapped in on the way after a
 * check stands in for it: Linux names the opened object itself (/proc/self/fd) and lists a folder through its open
 * descriptor (getdents64), a bounded read at a time; elsewhere the path is resolved again once open (a folder once
 * listed) and must still name the same object, and a folder whose size says it holds more than the entry budget is
 * left unlisted.
 */
import { constants } from "node:fs";
import { open, readdir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

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
/** the largest folder size (st_size) listed where entries cannot be read a few at a time: about the entry budget */
const MAX_FOLDER_BYTES = 64 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const FOLDER_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);

type Budget = { files: number; bytes: number; entries: number; steps: number };
type Listing = string[] | "refused" | "cut" | null;

/** a regular file's text when it is at most `cap` bytes, read from the open handle; null for anything else */
async function readHandle(handle: FileHandle, cap: number): Promise<string | null> {
  const found = await handle.stat();
  if (!found.isFile() || found.size > cap) return null;
  const buffer = Buffer.alloc(found.size);
  const { bytesRead } = await handle.read(buffer, 0, found.size, 0);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** A regular file's text when it is at most `cap` bytes; opened without blocking, so a FIFO never holds the list */
export async function readCapped(path: string, cap: number): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, READ_FLAGS);
    return await readHandle(handle, cap);
  } catch { return null; } finally { await handle?.close(); }
}

const inside = (path: string, roots: readonly string[]): boolean => roots.some((root) => {
  const rest = relative(root, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
});

/** whether the object open at `handle`, opened as `path`, really is inside `roots` */
async function openedInside(handle: FileHandle, path: string, roots: readonly string[]): Promise<boolean> {
  if (process.platform === "linux") return inside(await readlink(`/proc/self/fd/${handle.fd}`), roots);
  const real = await realpath(path);
  const [opened, named] = await Promise.all([handle.stat({ bigint: true }), stat(real, { bigint: true })]);
  return inside(real, roots) && opened.dev === named.dev && opened.ino === named.ino;
}

/** `path` opened, links followed as ssh does, when what was opened is inside `roots`; null when nothing is there */
async function openInside(path: string, roots: readonly string[], flags: number): Promise<FileHandle | "refused" | null> {
  let handle: FileHandle;
  try { handle = await open(path, flags); } catch { return null; }
  if (await openedInside(handle, path, roots).catch(() => false)) return handle;
  await handle.close();
  return "refused";
}

/** glibc's getdents64(2), which reads a folder's entries from its descriptor a buffer at a time; null without glibc */
const getdents = (() => {
  if (process.platform !== "linux") return null;
  try { return dlopen("libc.so.6", { getdents64: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 } }).symbols.getdents64; } catch { return null; }
})();

/** the names in a folder open at `fd`, each one charged to `budget.entries`; "cut" once it runs out */
function entriesOf(fd: number, read: NonNullable<typeof getdents>, budget: Budget): Listing {
  const buffer = Buffer.alloc(32 * 1024);
  const names: string[] = [];
  let got = Number(read(fd, buffer, buffer.byteLength));
  for (; got > 0; got = Number(read(fd, buffer, buffer.byteLength))) {
    // struct linux_dirent64: d_ino (8), d_off (8), d_reclen (2), d_type (1), then the name and its NUL
    for (let at = 0; at < got; at += buffer.readUInt16LE(at + 16)) {
      const name = buffer.toString("utf8", at + 19, buffer.indexOf(0, at + 19));
      if (name === "." || name === "..") continue;
      if (budget.entries-- <= 0) return "cut";
      names.push(name);
    }
  }
  return got < 0 ? null : names;
}

/** the names in folder `dir` when it really is inside `roots`, each charged to `budget.entries` */
async function listInside(dir: string, roots: readonly string[], budget: Budget): Promise<Listing> {
  if (getdents !== null) {
    const folder = await openInside(dir, roots, FOLDER_FLAGS);
    if (folder === null || folder === "refused") return folder;
    try { return entriesOf(folder.fd, getdents, budget); } finally { await folder.close(); }
  }
  const real = await realpath(dir).catch(() => null);
  if (real === null) return null;
  if (!inside(real, roots)) return "refused";
  try {
    const before = await stat(real, { bigint: true });
    if (!before.isDirectory()) return null;
    if (before.size > MAX_FOLDER_BYTES) return "cut";
    const names = await readdir(real);
    if (names.length > budget.entries) return "cut";
    budget.entries -= names.length;
    const after = await stat(await realpath(dir), { bigint: true });
    return after.dev === before.dev && after.ino === before.ino ? names : "refused";
  } catch { return null; }
}

/**
 * The files an Include pattern names: relative to `sshDir` as ssh reads the user config, `~` for the home folder. A
 * wildcard is walked one component at a time from the folder before it, each folder listed only when it is inside the
 * home or ssh folder; matches keep the spelling the pattern gives them and glob(3)'s order. A file ssh would read that is
 * left unread (out of those folders, past a budget, behind a pattern not matched exactly here, `~user`, a `%` token or
 * `${VAR}`, not a regular file of at most the size cap) comes back as null, so what it might set stays unknown; a file
 * that is not there is nothing, as for ssh.
 */
export function includer(sshDir: string, home: string): (pattern: string) => Promise<(string | null)[]> {
  const roots = Promise.all([sshDir, home].map((root) => realpath(root).catch(() => null)));
  const budget: Budget = { files: MAX_INCLUDED_FILES, bytes: MAX_INCLUDED_BYTES, entries: MAX_SCANNED_ENTRIES, steps: MAX_MATCH_STEPS };
  const escapes = sep === "/";
  return async (pattern) => {
    if (budget.files <= 0 || budget.bytes <= 0) return [null];
    // ssh expands `%` tokens, `${VAR}` and `~user` in an Include, which this offline reading does not
    if (/%|\$\{/.test(pattern) || (pattern.startsWith("~") && !pattern.startsWith("~/") && pattern !== "~")) return [null];
    const allowed = (await roots).filter((root): root is string => root !== null);
    const expanded = pattern === "~" || pattern.startsWith("~/") ? join(home, pattern.slice(2)) : isAbsolute(pattern) ? pattern : join(sshDir, pattern);
    const parts = expanded.split(escapes ? "/" : /[\\/]/).map((part) => part === "" ? { name: "" } : parseComponent(part, escapes));
    if (parts.includes(null)) return [null];
    const components = parts.filter((part): part is { name: string } | { tokens: Token[] } => part !== null);
    const first = components.findIndex((part) => "tokens" in part);
    const literal = (upTo: number) => components.slice(0, upTo).map((part) => "name" in part ? part.name : "").join(sep) || sep;
    // a scan cut short, or a folder left unlisted, may have missed a file sorted before the ones found
    let [scanCut, truncated] = [false, false];
    let paths: string[] = [];
    if (first < 0) paths = [literal(components.length)];
    else {
      let level = [literal(first)];
      for (const component of components.slice(first)) {
        const next: string[] = [];
        for (const dir of level) {
          if ("name" in component) { next.push(join(dir, component.name)); continue; }
          const names = await listInside(dir, allowed, budget);
          if (names === "refused" || names === "cut") { scanCut = true; continue; }
          for (const name of names ?? []) {
            const matched = matchComponent(component.tokens, name, budget);
            if (matched === null || (matched && next.length >= budget.files)) { scanCut = true; break; }
            if (matched) next.push(join(dir, name));
          }
        }
        level = next;
      }
      // ssh reads the files glob(3) returns, sorted by their spelling; a folder among them is no config
      const folders = await Promise.all(level.map((path) => stat(path).then((found) => found.isDirectory(), () => false)));
      paths = level.filter((_, at) => !folders[at]).sort();
    }
    const texts: (string | null)[] = [];
    for (const path of paths) {
      if (budget.files <= 0 || budget.bytes <= 0) { truncated = true; break; }
      const handle = await openInside(path, allowed, READ_FLAGS);
      if (handle === null) continue;
      if (handle === "refused") { texts.push(null); continue; }
      budget.files--;
      try {
        const text = await readHandle(handle, Math.min(MAX_FILE_BYTES, budget.bytes)).catch(() => null);
        if (text !== null) budget.bytes -= Buffer.byteLength(text);
        texts.push(text);
      } finally { await handle.close(); }
    }
    return [...(scanCut ? [null] : []), ...texts, ...(truncated ? [null] : [])];
  };
}
