/**
 * `ovis recover` (docs/account.md, "Recovery at the PC"): run by this PC's user in a terminal on it or over SSH, it
 * talks to the server over its recovery socket only (server/account/recovery.ts). Every release is asked at a
 * terminal, one row at a time; input that is not a terminal answers nothing.
 */
import type { RecoveryAction } from "../shared/account-devices-api.ts";

export interface RecoverIo {
  out(text: string): void;
  terminal: boolean;
  platform: NodeJS.Platform;
  ask(question: string): Promise<string>;
  send(request: RecoveryAction): Promise<unknown>;
}

interface WaitingRow {
  id: string;
  label: string;
  origin: { from: string; how: string } | null;
  waiting: string | null;
  last_seen_at: string | null;
  refusal: string | null;
}

const USAGE = "usage: ovis recover [--release <row id>... | --undo [<row id>...]]\n";

export async function runRecover(args: readonly string[], io: RecoverIo): Promise<number> {
  if (io.platform === "win32") {
    io.out("Recovery on Windows is the Ovis desktop app's own screen on this PC: open it there. This command opens nothing here.\n");
    return 1;
  }
  const [flag, ...ids] = args;
  if (flag !== undefined && flag !== "--release" && flag !== "--undo") { io.out(USAGE); return 2; }
  if (flag === "--release" && ids.length === 0) { io.out(USAGE); return 2; }
  if (flag === "--release" && !io.terminal) {
    io.out("This is not run in a terminal, so nothing can be released here. Run it in a terminal on this PC (over ssh, run ssh -t).\n");
    return 1;
  }
  try {
    if (flag === "--undo") {
      const answer = await io.send({ act: "undo", rows: ids.length > 0 ? ids : null }) as { releases?: string[]; error?: string; warning?: string };
      if (answer.error !== undefined) { io.out(`${answer.error}\n`); return 1; }
      io.out(`Ended ${answer.releases?.length ?? 0} release(s), each whole with every row it let in; their sessions were closed and the rows wait again.\n`);
      // the undo took effect; that it is missing from the device journal is the owner's to know
      if (answer.warning !== undefined) { io.out(`${answer.warning}\n`); return 1; }
      return 0;
    }
    const listed = await io.send({ act: "list" }) as { rows?: WaitingRow[]; error?: string };
    if (listed.error !== undefined) { io.out(`${listed.error}\n`); return 1; }
    const rows = listed.rows ?? [];
    if (flag === undefined) {
      if (rows.length === 0) { io.out("No device waits for this PC's account to be read.\n"); return 0; }
      for (const row of rows) io.out(`${describe(row)}\n`);
      io.out("Release one with: ovis recover --release <row id>\n");
      return 0;
    }
    let failed = false;
    for (const id of ids) {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined) { io.out(`${id}: no such row waits here.\n`); failed = true; continue; }
      if (row.refusal !== null) { io.out(`${id}: cannot be released (${row.refusal}).\n`); failed = true; continue; }
      const answer = (await io.ask(`${describe(row)}\nRelease ${row.label} until this PC's account is read? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") { io.out("Not released.\n"); continue; }
      const released = await io.send({ act: "release", rows: [id] }) as { released?: string[]; error?: string };
      if (released.error !== undefined) { io.out(`${id}: ${released.error}\n`); failed = true; continue; }
      io.out(`Released ${row.label}. It signs in until this PC's account is read, or until ovis recover --undo.\n`);
    }
    return failed ? 1 : 0;
  } catch {
    io.out("Ovis did not answer on its recovery socket. Is it running on this PC, as this user, with recovery turned on?\n");
    return 1;
  }
}

function describe(row: WaitingRow): string {
  const origin = row.origin === null ? "unknown origin" : `${row.origin.from}/${row.origin.how}`;
  const seen = row.last_seen_at ?? "never";
  return `${row.id}  ${row.label}  ${origin}  waits: ${row.waiting ?? "no"}  last seen: ${seen}  ${row.refusal === null ? "can be released" : `cannot be released: ${row.refusal}`}`;
}
