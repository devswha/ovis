/**
 * A folder listed through its open descriptor with libc's fdopendir(3) and readdir(3), for server/ssh-include.ts where
 * glibc's getdents64 is not there (macOS, a Linux with musl). Each record is copied out at the platform's struct dirent
 * layout and checked before its name is used; the listing stops at the folder-entry budget, so a huge folder is never
 * read whole. Like getdents64 it is called synchronously through bun:ffi, so a stalled network mount blocks the event
 * loop until it answers.
 */
import { dlopen, FFIType, read, toArrayBuffer, type Pointer } from "bun:ffi";

/** where a record's fields sit: macOS's 64-bit-inode struct dirent, or Linux's (musl's, and glibc's on 64-bit) */
export type Layout = "darwin" | "linux";
// darwin: d_ino (8), d_seekoff (8), d_reclen (2), d_namlen (2), d_type (1), d_name[1024]; sizeof 1048
// linux: d_ino (8), d_off (8), d_reclen (2), d_type (1), d_name[256]; sizeof 280
const LAYOUTS: Record<Layout, { name: number; size: number }> = { darwin: { name: 21, size: 1048 }, linux: { name: 19, size: 280 } };

/** fdopendir(3) over a copy of an open folder's descriptor (null when it fails), readdir(3) one record's bytes at a time, closedir(3) */
export type DirStream = {
  layout: Layout;
  open: (fd: number) => Pointer | null;
  next: (dir: Pointer) => Buffer | "end" | "failed";
  close: (dir: Pointer) => void;
};

/** libc at `path`, read at `layout`; null where it has not the calls (Windows, another libc) */
export function loadDirStream(path: string, layout: Layout): DirStream | null {
  // an Intel Mac's readdir answers the 32-bit-inode layout; its 64-bit-inode calls carry this suffix
  const inode64 = layout === "darwin" && process.arch === "x64" ? "$INODE64" : "";
  const [fdopendirName, readdirName, errnoName] = [`fdopendir${inode64}`, `readdir${inode64}`, layout === "darwin" ? "__error" : "__errno_location"];
  let calls;
  try {
    // each named apart, as a name only known when running would widen every call's type
    calls = {
      ...dlopen(path, {
        dup: { args: [FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
      }).symbols,
      fdopendir: dlopen(path, { [fdopendirName]: { args: [FFIType.i32], returns: FFIType.ptr } }).symbols[fdopendirName],
      readdir: dlopen(path, { [readdirName]: { args: [FFIType.ptr], returns: FFIType.ptr } }).symbols[readdirName],
      errnoAt: dlopen(path, { [errnoName]: { args: [], returns: FFIType.ptr } }).symbols[errnoName],
    };
  } catch { return null; }
  const { dup, close, closedir, fdopendir, readdir, errnoAt } = calls;
  const errnoPointer = errnoAt?.();
  if (fdopendir === undefined || readdir === undefined || typeof errnoPointer !== "number") return null;
  // the calling thread's errno, which readdir sets only on a failure: zeroed before each call to tell its end apart
  const errno = new Int32Array(toArrayBuffer(errnoPointer, 0, 4));
  const { name, size } = LAYOUTS[layout];
  return {
    layout,
    // the copy has no close-on-exec flag: it lives only within one synchronous listing, so no spawn can come between
    open: (fd) => {
      const copy = Number(dup(fd));
      if (copy < 0) return null;
      const dir = fdopendir(copy);
      if (typeof dir === "number") return dir;
      close(copy);
      return null;
    },
    next: (dir) => {
      errno[0] = 0;
      const entry = readdir(dir);
      if (typeof entry !== "number") return errno[0] === 0 ? "end" : "failed";
      // the header is always there; past it, no more than the record says nor the struct holds is read
      const length = Math.min(Math.max(read.u16(entry, 16), name), size);
      return Buffer.from(new Uint8Array(toArrayBuffer(entry, 0, length)));
    },
    close: (dir) => { closedir(dir); },
  };
}

/** this platform's libc where it has no getdents64: macOS's, or musl's on Linux; null elsewhere (Windows) */
export function platformDirStream(): DirStream | null {
  if (process.platform === "darwin") return loadDirStream("libc.dylib", "darwin") ?? loadDirStream("/usr/lib/libSystem.B.dylib", "darwin");
  if (process.platform !== "linux") return null;
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  return loadDirStream(`libc.musl-${arch}.so.1`, "linux") ?? loadDirStream("libc.so", "linux");
}

/**
 * The name in one record, or null when it is not well formed: a d_reclen shorter than a one-character name or longer
 * than the bytes copied, a name with no terminator inside the record, a d_namlen (macOS) other than the name's length,
 * or a name whose bytes are not UTF-8 (a file that cannot be opened by the name decoded)
 */
function nameIn(record: Buffer, layout: Layout): string | null {
  const at = LAYOUTS[layout].name;
  if (record.length < at) return null;
  const reclen = record.readUInt16LE(16);
  const end = record.indexOf(0, at);
  if (reclen < at + 2 || reclen > record.length || end <= at || end >= reclen) return null;
  if (layout === "darwin" && record.readUInt16LE(18) !== end - at) return null;
  const found = record.toString("utf8", at, end);
  return Buffer.from(found).equals(record.subarray(at, end)) ? found : null;
}

/**
 * The names in the folder open at `fd`, each record charged to `budget.entries` (`.` and `..` too); "unread" once it
 * runs out, when fdopendir or readdir fails, or when a record is not well formed
 */
export function streamEntries(fd: number, stream: DirStream, budget: { entries: number }): string[] | "unread" {
  const dir = stream.open(fd);
  if (dir === null) return "unread";
  try {
    const names: string[] = [];
    for (;;) {
      const record = stream.next(dir);
      if (record === "end") return names;
      if (record === "failed") return "unread";
      const found = nameIn(record, stream.layout);
      if (found === null || budget.entries-- <= 0) return "unread";
      if (found !== "." && found !== "..") names.push(found);
    }
  } finally { stream.close(dir); }
}
