import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, type PlatformPath, resolve, sep } from "node:path";

import type { DirectoryListing } from "../shared/protocol.ts";
import { otherHostsShare } from "./windows-share.ts";

export const MAX_DIRECTORY_ENTRIES = 500;

/** The name limit on every common filesystem. */
const MAX_NAME_BYTES = 255;

export function resolveFolder(path: string, home: string, base?: string, rules: Pick<PlatformPath, "resolve" | "sep"> = { resolve, sep }): string | null {
  const trimmed = path.trim();
  const folder = trimmed === "" || trimmed === "~" ? home : trimmed.startsWith("~/") ? rules.resolve(home, trimmed.slice(2)) : base !== undefined ? rules.resolve(base, trimmed) : rules.resolve(trimmed);
  return rules.sep === "\\" && otherHostsShare(folder, [base === undefined ? null : rules.resolve(base), rules.resolve(home), rules.resolve(".")]) ? null : folder;
}

export function expandedPath(value: string, own: ReadonlyArray<string | null> | "chosen" = [], rules: Pick<PlatformPath, "resolve" | "sep"> = { resolve, sep }, home = homedir()): string | null {
  const expanded = value === "~" ? home : value.startsWith("~/") ? rules.resolve(home, value.slice(2)) : rules.resolve(value);
  return own !== "chosen" && rules.sep === "\\" && otherHostsShare(expanded, [...own, rules.resolve(home), rules.resolve(".")]) ? null : expanded;
}

export function expandedDirectory(value: string, own: ReadonlyArray<string | null> | "chosen" = [], rules?: Pick<PlatformPath, "resolve" | "sep">, home?: string): string | null {
  const expanded = expandedPath(value, own, rules, home);
  if (expanded === null) return null;
  try {
    return statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null;
  }
}

export type CreateDirectoryResult =
  | { path: string }
  | { error: "invalid_cwd" | "invalid_name" | "folder_exists" | "permission_denied" };

export function createDirectory(parent: string, name: string): CreateDirectoryResult {
  const target = resolveFolder(parent, homedir());
  if (target === null) return { error: "invalid_cwd" };
  try {
    if (!statSync(target).isDirectory()) return { error: "invalid_cwd" };
  } catch {
    return { error: "invalid_cwd" };
  }
  const folder = name.trim();
  if (folder === "" || folder === "." || folder === ".." || /[/\\\0]/.test(folder) || Buffer.byteLength(folder) > MAX_NAME_BYTES) return { error: "invalid_name" };
  const path = join(target, folder);
  try {
    mkdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { error: "folder_exists" };
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { error: "permission_denied" };
    // the parent went away meanwhile; a name Windows will not take (`a:b`, `con`) is EINVAL or ENOENT there
    if (code === "ENOENT" || code === "ENOTDIR") return { error: process.platform === "win32" ? "invalid_name" : "invalid_cwd" };
    if (code === "EINVAL" || code === "ENAMETOOLONG") return { error: "invalid_name" };
    throw error;
  }
  return { path };
}

export function listDirectories(path: string, hidden = false, withFiles = false, base?: string): DirectoryListing | null {
  const home = homedir();
  const target = resolveFolder(path, home, base);
  if (target === null) return null;
  let entries;
  try {
    if (!statSync(target).isDirectory()) return null;
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories: string[] = [];
  const files: { name: string; size: number }[] = [];
  for (const entry of entries) {
    if (!hidden && entry.name.startsWith(".")) continue;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try { const target_ = statSync(join(target, entry.name)); isDirectory = target_.isDirectory(); isFile = target_.isFile(); } catch { isDirectory = false; isFile = false; }
    }
    if (isDirectory) directories.push(entry.name);
    else if (withFiles && isFile && files.length <= MAX_DIRECTORY_ENTRIES) {
      let size = 0;
      try { size = statSync(join(target, entry.name)).size; } catch { continue; }
      files.push({ name: entry.name, size });
    }
  }
  const byName = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
  directories.sort(byName);
  files.sort((left, right) => byName(left.name, right.name));
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: directories.length > MAX_DIRECTORY_ENTRIES || files.length > MAX_DIRECTORY_ENTRIES,
    ...(withFiles ? { files: files.slice(0, MAX_DIRECTORY_ENTRIES) } : {}),
  };
}
