import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";
import { sep } from "node:path";

import type { FileInfo } from "../shared/protocol.ts";
import { fileInfo, pageFileHooks, pageWithLocalFiles, pathsByName, type PageMedia, type PageMediaGrant } from "./file-view.ts";
import { walkFiles } from "./files.ts";

/**
 * What a file thread (`file-pool.ts`) does: each synchronous filesystem step of the file routes,
 * named so that a request can ask for it and wait without holding the server's thread.
 */
export type FileTask =
  | { op: "info"; path: string }
  | { op: "named"; path: string }
  | { op: "within"; paths: string[]; folder: string }
  | { op: "walk"; cwd: string }
  | { op: "render"; path: string; media: PageMedia | null }
  /** `opened`: where the thread names the descriptor as soon as it has it (`file-pool.ts`) */
  | { op: "open"; path: string; opened?: Int32Array<SharedArrayBuffer> };

/** A page drawn with its own files put into it (null when it cannot be), and the media addresses that render gave out. */
export interface RenderedPage { html: Uint8Array<ArrayBuffer> | null; grants: PageMediaGrant[] }
/** A file opened to stream, and its size when it was opened. */
export interface OpenedFile { fd: number; size: number }

export type FileTaskResult = FileInfo | FileInfo[] | string[] | boolean | RenderedPage | OpenedFile | null;

export function runFileTask(task: FileTask): FileTaskResult {
  switch (task.op) {
    case "info": return fileInfo(task.path);
    case "named": return pathsByName(task.path).map(fileInfo).filter((info) => info !== null);
    case "within": return within(task.paths, task.folder);
    case "walk": return walkFiles(task.cwd);
    case "render": return render(task.path, task.media);
    case "open": return open(task.path, task.opened);
  }
}

/** What a thread hands over rather than copies: a rendered page's bytes. */
export function transferablesOf(result: FileTaskResult): ArrayBuffer[] {
  if (result !== null && typeof result === "object" && "html" in result && result.html !== null) return [result.html.buffer];
  return [];
}

/** Every path, symlinks followed, lies in `folder`; false for a missing or unreadable one. */
function within(paths: string[], folder: string): boolean {
  try {
    const root = realpathSync(folder) + sep;
    return paths.every((path) => realpathSync(path).startsWith(root));
  } catch { return false; }
}

function render(path: string, media: PageMedia | null): RenderedPage {
  const grants: PageMediaGrant[] = [];
  const html = pageWithLocalFiles(path, media, (grant) => grants.push(grant));
  return { html: html === null ? null : new TextEncoder().encode(html), grants };
}

/** O_NONBLOCK, so a FIFO put where the file was is not waited on. */
function open(path: string, opened?: Int32Array<SharedArrayBuffer>): OpenedFile | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  if (opened !== undefined) Atomics.store(opened, 0, fd);
  // the stream closes it through `release`, which tells `pageFileHooks.closed`
  pageFileHooks.opened?.(fd);
  try {
    const stat = fstatSync(fd);
    if (stat.isFile()) return { fd, size: stat.size };
  } catch { /* refused below */ }
  // not handed over: closed by whoever takes it from the cell first, here or `abandon` (file-pool.ts)
  if (opened === undefined || Atomics.compareExchange(opened, 0, fd, -1) === fd) closeSync(fd);
  return null;
}
