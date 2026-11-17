import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncDirectory } from "./private-state.ts";
import { basename, dirname } from "node:path";

export type StateDocument = { kind: "missing" } | { kind: "json"; value: unknown } | { kind: "malformed" };

export function readStateDocument(path: string): StateDocument {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try { return { kind: "json", value: JSON.parse(text) }; } catch { return { kind: "malformed" }; }
}

export const damagedCopy = (path: string): string => `${path}.bad`;

export function setAsideDamaged(path: string, now = new Date()): string {
  // no ':' in a Windows file name
  const name = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
  let aside = name;
  try {
    chmodSync(path, 0o600);
    // a rename would replace a copy of the same name; a link or exclusive copy refuses to
    for (let attempt = 1; !keepAs(path, aside); attempt += 1) {
      if (attempt > 99) throw Object.assign(new Error("too many copies"), { code: "EEXIST" });
      aside = `${name}-${attempt}`;
    }
    try { flushFile(aside); } catch (error) { dropCopy(aside); throw error; }
    syncDirectory(dirname(path), process.platform);
    try { unlinkSync(path); } catch (error) { dropCopy(aside); throw error; }
    syncDirectory(dirname(path), process.platform);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`${basename(path)} is not JSON and cannot be set aside as ${basename(aside)} (${reason})`);
  }
  return aside;
}

function keepAs(path: string, aside: string): boolean {
  try { linkSync(path, aside); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
  }
  try { copyFileSync(path, aside, constants.COPYFILE_EXCL); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { chmodSync(aside, 0o600); }
  catch (error) { dropCopy(aside); throw error; }
  return true;
}

function flushFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function dropCopy(aside: string): void {
  try { rmSync(aside, { force: true }); } catch {}
}

export function holdsDocument(path: string, text: string): boolean {
  try { return JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === text; } catch { return false; }
}

export function writeStateDocument(path: string, text: string, keepDamaged: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // a name no one can guess, created exclusively ("wx": O_CREAT | O_EXCL, which follows no link at that name), so
  // a link planted beside the document never receives it (#3437); flushed before the rename, as writePrivateState does,
  // so a crash never leaves the document renamed in but empty
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let open = true;
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
    open = false; // a failed close is not retried: the descriptor is released either way
    closeSync(fd);
  } catch (error) {
    if (open) try { closeSync(fd); } catch {}
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  if (keepDamaged) {
    try {
      chmodSync(path, 0o600);
      renameSync(path, damagedCopy(path));
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch {}
      const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
      throw new Error(`Cannot keep the damaged ${basename(path)} as ${basename(damagedCopy(path))} (${reason}), so it was not replaced`);
    }
  }
  try { renameSync(temporary, path); }
  catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  syncDirectory(dirname(path), process.platform);
}
