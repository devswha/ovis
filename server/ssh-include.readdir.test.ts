import { expect, it } from "bun:test";
import { ptr } from "bun:ffi";
import { mkdirSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { sshCandidates } from "./ssh-candidates.ts";
import { sshDir, twoPeers } from "./ssh-candidates.fixture.ts";
import { loadDirStream, platformDirStream, type DirStream } from "./ssh-include-dir.ts";
import { includeTestOnly } from "./ssh-include.ts";

// a wildcard Include listed through the folder's descriptor with fdopendir/readdir, as on macOS and a Linux with musl
/**
 * the real calls, which every platform but Windows must load: glibc's (Linux's layout, the opened object named through
 * /proc as macOS's proc_pidfdinfo would) on a Linux test host, this platform's own elsewhere
 */
const real = process.platform === "linux" ? loadDirStream("libc.so.6", "linux") : platformDirStream();
const calls = (): DirStream => {
  if (real === null) throw new Error("fdopendir/readdir did not load");
  return process.platform === "linux" ? { ...real, pathOf: (fd) => readlinkSync(`/proc/self/fd/${fd}`) } : real;
};
const windows = process.platform === "win32";

/** the rows of a config in `dir`'s ssh folder (or `dir` itself) with `stream` listing its folders as on macOS */
async function rowsWith(stream: DirStream, dir: string, ssh = dir): Promise<(string | undefined)[][]> {
  Object.assign(includeTestOnly, { getdents: null, dirStream: stream, platform: "darwin" });
  try {
    return (await sshCandidates({ sshDir: ssh, home: dir, readStatus: async () => twoPeers })).map((candidate) => [candidate.name, candidate.tailnet]);
  } finally { for (const key of ["getdents", "dirStream", "platform"] as const) delete includeTestOnly[key]; }
}
const box = (files: Record<string, string>) => sshDir({ ...files, config: "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
const claimed = [["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]];
const unread = [["box", undefined], ...claimed];
const fromFile = [["box", "other.tail.ts.net"], ["box", "box.tail.ts.net"]];

it.skipIf(windows)("claims a PC for a host after a wildcard Include listed through the folder's descriptor", async () => {
  expect(await rowsWith(calls(), box({ "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n" }))).toEqual(fromFile);
});

it.skipIf(windows)("never lists a folder swapped for a link out of home after it was opened and checked", async () => {
  const home = sshDir({ "notes/leak": "Host leaked\n  HostName 100.64.0.1\n", ".ssh/conf.d/own.conf": "# nothing\n", ".ssh/config": "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  const outside = sshDir({});
  symlinkSync(join(home, "notes", "leak"), join(outside, "evil"));
  const folder = join(home, ".ssh", "conf.d");
  const swapping: DirStream = { ...calls(), open: (fd) => { renameSync(folder, `${folder}.old`); symlinkSync(outside, folder); return calls().open(fd); } };
  expect(await rowsWith(swapping, home, join(home, ".ssh"))).toEqual(claimed);
});

it.skipIf(windows)("reads what a listing matched from the folder it listed, even one swapped after the listing", async () => {
  const dir = box({ "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n" });
  mkdirSync(join(dir, "empty"));
  const folder = join(dir, "conf.d");
  const swapping: DirStream = { ...calls(), next: (at) => {
    const record = calls().next(at);
    if (record === "end") { renameSync(folder, `${folder}.old`); symlinkSync(join(dir, "empty"), folder); }
    return record;
  } };
  expect(await rowsWith(swapping, dir)).toEqual(fromFile);
});

it.skipIf(windows)("leaves an Include unread when the kernel names the opened folder outside home", async () => {
  const outside = sshDir({});
  expect(await rowsWith({ ...calls(), pathOf: () => outside }, box({ "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n" }))).toEqual(unread);
});

it.skipIf(windows)("reads no record past the folder-entry budget", async () => {
  const files: Record<string, string> = {};
  // dot-names, which `*` never matches, so only the entry budget can cut the listing
  for (let index = 0; index < 1100; index++) files[`conf.d/.n${String(index).padStart(4, "0")}`] = "";
  let reads = 0;
  const counting: DirStream = { ...calls(), next: (dir) => { reads++; return calls().next(dir); } };
  expect(await rowsWith(counting, box(files))).toEqual(unread);
  expect(reads).toBe(1024);
});

/** one macOS struct dirent naming `name`: d_reclen `reclen`, d_namlen `namlen`, `bytes` long, the name terminated unless `open` */
const record = (name: string, { reclen = 32, namlen = name.length, bytes = reclen, open = false }: { reclen?: number; namlen?: number; bytes?: number; open?: boolean } = {}): Buffer => {
  const written = Buffer.alloc(bytes, open ? 0x61 : 0);
  written.writeUInt16LE(reclen, 16);
  written.writeUInt16LE(namlen, 18);
  written.write(name, 21);
  return written;
};
/** stands for the DIR a fake fdopendir answers */
const folder = new Uint8Array(1);
/** a macOS readdir answering `answers` one call at a time, then the end of the folder; the folder's files opened for real */
const answering = (answers: (Buffer | "failed")[]): DirStream => ({ ...calls(), layout: "darwin", open: () => ptr(folder), next: () => answers.shift() ?? "end", close: () => {} });

it.skipIf(windows)("reads a macOS struct dirent, and leaves an Include unread when readdir fails or answers a record it cannot trust", async () => {
  const files = { "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n" };
  expect(await rowsWith(answering([record("."), record("x.conf")]), box(files))).toEqual(fromFile);
  for (const answers of [["failed"] as const, [record("x.conf", { namlen: 7 })], [record("x.conf", { reclen: 64, bytes: 32 })], [record("x.conf", { reclen: 22 })], [record("x.conf", { open: true })]]) {
    expect(await rowsWith(answering([...answers]), box(files))).toEqual(unread);
  }
  expect(await rowsWith({ ...answering([]), open: () => null }, box(files))).toEqual(unread);
});
