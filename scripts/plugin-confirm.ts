/**
 * `ovis confirm` (docs/account.md, "Confirmed on this PC"): shows this PC's own confirm page, where an act a window
 * asked for (strict mode on or off) waits for approval. The port is only in local-confirm.json in this PC's state
 * folder, so only the user that folder belongs to learns it, and the command opens only an address it builds itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { privateStateRefusal } from "../server/private-state.ts";

export interface ConfirmIo {
  stateDir: string;
  platform: NodeJS.Platform;
  uid: number | undefined;
  /** a desktop session is there to open a browser in */
  desktop: boolean;
  out(text: string): void;
  open(url: string): void;
}

/** The page's address from the file's text, or null unless the file is exactly `{ "port": <1..65535> }`. */
export function confirmPageUrl(text: string): string | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const port = (value as { port?: unknown }).port;
  if (keys.length !== 1 || keys[0] !== "port" || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://127.0.0.1:${port}/`;
}

export async function runConfirm(io: ConfirmIo): Promise<number> {
  if (io.platform !== "linux") {
    io.out("This PC has no confirm page: screen confirmation is Linux only for now.\n");
    return 1;
  }
  const path = join(io.stateDir, "local-confirm.json");
  const refusal = privateStateRefusal(path, io.platform, io.uid);
  if (refusal !== null) {
    io.out(`The confirm page was not opened: ${refusal}. Run ovis confirm as the user Ovis runs as.\n`);
    return 1;
  }
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    io.out("No confirm page is open: Ovis is not running on this PC with the account release on.\n");
    return 1;
  }
  const url = confirmPageUrl(text);
  if (url === null) {
    io.out(`${path} does not name a port, so nothing was opened. Restart Ovis to write it again.\n`);
    return 1;
  }
  io.out(`Approve or decline on this PC's confirm page: ${url}\n`);
  if (io.desktop) io.open(url);
  return 0;
}
