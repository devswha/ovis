import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const privateStateFs = { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync };

export interface PrivateStateWrite {
  directorySynced: boolean;
}

export function writePrivateState(path: string, value: unknown, platform: NodeJS.Platform = process.platform): PrivateStateWrite {
  const temporary = preparePrivateState(path, value, platform);
  try { privateStateFs.renameSync(temporary, path); }
  catch (error) {
    try { privateStateFs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return syncDirectory(dirname(path), platform);
}

export function publishPrivateState(temporary: string, path: string, platform: NodeJS.Platform = process.platform): PrivateStateWrite {
  privateStateFs.renameSync(temporary, path);
  return syncDirectory(dirname(path), platform);
}

export function preparePrivateState(path: string, value: unknown, platform: NodeJS.Platform = process.platform): string {
  const fs = privateStateFs;
  const directory = dirname(path);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  // The descriptor stays writable whatever the mode: O_CREAT applies it only to later opens.
  // Windows modes carry no owner privacy, and a read-only temporary file there could not be
  // cleaned up.
  const existing = platform === "win32" ? undefined : statSync(path, { throwIfNoEntry: false });
  const mode = existing === undefined ? 0o600 : existing.mode & 0o600;
  let fd: number | null = fs.openSync(temporary, "wx", mode);
  try {
    for (let written = 0; written < bytes.length;) {
      const count = fs.writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error(`wrote no bytes to ${temporary}`);
      written += count;
    }
    fs.fsyncSync(fd);
    const closing = fd;
    fd = null; // a failed close must not be retried: the descriptor is released either way
    fs.closeSync(closing);
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return temporary;
}

export function syncDirectory(directory: string, platform: NodeJS.Platform): PrivateStateWrite {
  const fs = privateStateFs;
  if (platform === "win32") return { directorySynced: false };
  let directoryFd: number | null = null;
  try {
    directoryFd = fs.openSync(directory, "r");
    fs.fsyncSync(directoryFd);
    return { directorySynced: true };
  } catch {
    return { directorySynced: false };
  } finally {
    if (directoryFd !== null) try { fs.closeSync(directoryFd); } catch {}
  }
}
