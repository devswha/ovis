/**
 * A folder listed through its open descriptor for server/ssh-include.ts: glibc's getdents64 records, or libc's
 * fdopendir(3) and readdir(3) where getdents64 is not there (macOS, a Linux with musl). Each record is checked before
 * its name is used, and the listing stops at the folder-entry budget, so a huge folder is never read whole (readdir
 * reads no record past it; getdents64 reads 32 KiB at a time, so at most one more such read). The same libc (glibc's
 * too) opens what a listing matched relative to the folder still held (openat), and names what a descriptor holds on
 * macOS. Like getdents64 every call is synchronous through bun:ffi and cannot be cut short, so a folder on a stalled
 * network mount (an NFS or SMB home) blocks the server's event loop, every request with it, until the mount answers,
 * while the SSH list is built.
 */
import { dlopen, FFIType, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { constants } from "node:fs";

/** where a record's fields sit: macOS's 64-bit-inode struct dirent, or Linux's (musl's, and glibc's on 64-bit) */
export type Layout = "darwin" | "linux";
// darwin: d_ino (8), d_seekoff (8), d_reclen (2), d_namlen (2), d_type (1), d_name[1024]; sizeof 1048
// linux: d_ino (8), d_off (8), d_reclen (2), d_type (1), d_name[256]; sizeof 280
const LAYOUTS: Record<Layout, { name: number; size: number }> = { darwin: { name: 21, size: 1048 }, linux: { name: 19, size: 280 } };

/**
 * fdopendir(3) over a copy of an open folder's descriptor (null when it fails), readdir(3) one record's bytes at a time,
 * closedir(3); openat(2) of a path relative to an open folder (the descriptor, or minus errno); on macOS the path of the
 * object open at a descriptor, as the kernel names it (proc_pidfdinfo), null elsewhere
 */
export type DirStream = {
  layout: Layout;
  open: (fd: number) => Pointer | null;
  next: (dir: Pointer) => Buffer | "end" | "failed";
  close: (dir: Pointer) => void;
  openAt: (dir: number, path: string, flags: number) => number;
  pathOf: ((fd: number) => string | null) | null;
};
/** O_CLOEXEC, which node:fs does not name */
const CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0x80000;
/** struct vnode_fdinfowithpath: 1200 bytes, vip_path at 176 (macOS <sys/proc_info.h>); PROC_PIDFDVNODEPATHINFO is 2 */
const [FDINFO_SIZE, FDINFO_PATH, VNODEPATHINFO] = [1200, 176, 2];

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
        // variadic only in a mode it reads with O_CREAT, so called with the fixed arguments alone
        openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
      }).symbols,
      fdopendir: dlopen(path, { [fdopendirName]: { args: [FFIType.i32], returns: FFIType.ptr } }).symbols[fdopendirName],
      readdir: dlopen(path, { [readdirName]: { args: [FFIType.ptr], returns: FFIType.ptr } }).symbols[readdirName],
      errnoAt: dlopen(path, { [errnoName]: { args: [], returns: FFIType.ptr } }).symbols[errnoName],
      // fcntl(F_GETPATH) takes its buffer as a variadic argument, which an Apple arm64 callee reads from the stack
      pidfdinfo: layout === "darwin" ? dlopen(path, { proc_pidfdinfo: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } }).symbols.proc_pidfdinfo : null,
    };
  } catch { return null; }
  const { openat, close, closedir, fdopendir, readdir, errnoAt, pidfdinfo } = calls;
  const errnoPointer = errnoAt?.();
  if (fdopendir === undefined || readdir === undefined || typeof errnoPointer !== "number") return null;
  // the calling thread's errno, which readdir sets only on a failure: zeroed before each call to tell its end apart
  const errno = new Int32Array(toArrayBuffer(errnoPointer, 0, 4));
  const { name, size } = LAYOUTS[layout];
  return {
    layout,
    // the folder itself again (its `.`), close-on-exec from the start, which dup cannot give
    open: (fd) => {
      const copy = openat(fd, Buffer.from(".\0"), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | CLOEXEC);
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
    openAt: (dir, relative, flags) => {
      // a NUL would end the path early, naming another file
      if (relative.includes("\0")) return -22;
      errno[0] = 0;
      const fd = openat(dir, Buffer.from(`${relative}\0`), flags | CLOEXEC);
      return fd >= 0 ? fd : -(errno[0] || 22);
    },
    pathOf: pidfdinfo === null ? null : (fd) => {
      const info = Buffer.alloc(FDINFO_SIZE);
      if (pidfdinfo(process.pid, fd, VNODEPATHINFO, info, FDINFO_SIZE) !== FDINFO_SIZE) return null;
      const end = info.indexOf(0, FDINFO_PATH);
      if (end <= FDINFO_PATH) return null;
      const found = info.toString("utf8", FDINFO_PATH, end);
      return Buffer.from(found).equals(info.subarray(FDINFO_PATH, end)) ? found : null;
    },
  };
}

/** getdents64(2): fills `buffer` with a folder's entries from its descriptor and answers the bytes written, or -1 */
export type Getdents = (fd: number, buffer: Buffer, length: number) => number | bigint;

/**
 * The names in a folder open at `fd`, each one charged to `budget.entries`; "unread" once it runs out, when getdents64
 * fails, or when what it answers is not well formed (a byte count past the buffer, a record that is empty, runs past
 * the bytes answered, or holds no terminated name)
 */
export function entriesOf(fd: number, read: Getdents, budget: { entries: number }): string[] | "unread" {
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

/** this platform's libc: macOS's, or glibc's or musl's on Linux; null elsewhere (Windows) */
export function platformDirStream(): DirStream | null {
  if (process.platform === "darwin") return loadDirStream("libc.dylib", "darwin") ?? loadDirStream("/usr/lib/libSystem.B.dylib", "darwin");
  if (process.platform !== "linux") return null;
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  return loadDirStream("libc.so.6", "linux") ?? loadDirStream(`libc.musl-${arch}.so.1`, "linux") ?? loadDirStream("libc.so", "linux");
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
 * The names in the folder open at `fd`, each record charged to `budget.entries` (`.` and `..` too), none read past it;
 * "unread" once it runs out (a folder of exactly the records left too), when fdopendir or readdir fails, or when a
 * record is not well formed
 */
export function streamEntries(fd: number, stream: DirStream, budget: { entries: number }): string[] | "unread" {
  const dir = stream.open(fd);
  if (dir === null) return "unread";
  try {
    const names: string[] = [];
    for (;;) {
      if (budget.entries <= 0) return "unread";
      const record = stream.next(dir);
      if (record === "end") return names;
      if (record === "failed") return "unread";
      const found = nameIn(record, stream.layout);
      if (found === null) return "unread";
      budget.entries--;
      if (found !== "." && found !== "..") names.push(found);
    }
  } finally { stream.close(dir); }
}
