/**
 * `ovis fleet ...` (from source `bun scripts/plugin.ts fleet ...`): the fleet's owner on this PC, talking to the local
 * server's fleet routes (docs/fleet-link.md section 4) with the authority every `ovis` command uses for its own server
 * (scripts/plugin.ts: loopback, the token of the plugin's config folder when one is set). Those routes decide who may
 * call them (server/dispatch.ts, todo 30's rule): nothing here widens them. A machine is named by its id (or its
 * fingerprint) or by a name that matches exactly one machine, never by any one controller's notion of it.
 *
 * Secrets: an invite's secret goes only into a new 0600 file (`invite --out`), or, with `invite --line`, to a terminal
 * (or wherever `--force-stdout` sends it); the owner key's recovery phrase only to a terminal or a new 0600 file. No
 * `--json` answer, error or log line carries either.
 */
import { accessSync, closeSync, constants, fchmodSync, ftruncateSync, lstatSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fleetOwner, fleetOwnerRestore, fleetOwnerText, readPhraseFile } from "../server/fleet/cli.ts";
import { InviteError, inviteLine, parseInvite } from "../server/fleet/invites.ts";

/** The exit codes of every `ovis fleet` command (docs/fleet-link.md, "`ovis fleet`"). */
export const FLEET_EXIT = {
  ok: 0,
  /** anything not named below: an answer this command cannot read, a file it cannot write */
  failed: 1,
  /** the command line, or a rule of this command (no terminal for a secret, an existing file) */
  usage: 2,
  /** no machine or batch by that name, or a name that matches more than one machine */
  unknown: 3,
  /** no Ovis server answers at the address the `ovis` commands use */
  not_running: 4,
  /** the fleet is not on yet: `ovis fleet on` first */
  fleet_off: 5,
  /** the server refused (no token, not the owner, no carrier), or the owner did not confirm at the prompt */
  refused: 6,
  /** the batch changed since it was shown: nothing was confirmed */
  changed: 7,
  /** the server has no OVIS_TOKEN, so its fleet is held (server/fleet/gate.ts): set it and restart Ovis */
  fleet_token_required: 8,
} as const;
type Exit = (typeof FLEET_EXIT)[keyof typeof FLEET_EXIT];

export interface FleetCommandIo {
  /** the local server, as scripts/plugin.ts reaches it */
  readonly origin: string;
  /** the local authority: `authorization` when the plugin's config holds a token */
  readonly headers: Readonly<Record<string, string>>;
  /** the server's state folder (`fleet on` makes the owner key there) */
  readonly stateDir: string;
  readonly stdoutTTY: boolean;
  readonly stdinTTY: boolean;
  out(text: string): void;
  err(text: string): void;
  /** One line typed on the terminal after `question`, or null when there is none. */
  ask(question: string): Promise<string | null>;
}

export const FLEET_HELP = `usage: ovis fleet <command> [options]

  on [--phrase-file <path>] [--json]
      Turn the fleet on: make its owner key once and show its recovery phrase once, only on a terminal or into the
      new file --phrase-file names (mode 0600). A second run says the fleet is on and shows nothing.
  on --restore [--phrase-file <path>] [--json]
      Put the owner key back from its recovery phrase, typed at the prompt or read from --phrase-file (a file of mode
      0600; never an argument). Another owner key already here is never replaced.
  invite --out <dir> [--count N] [--prefix P] [--ttl 1h] [--json]
      Mint N invites (1-256, default 1) valid for --ttl (60s to 24h, default 1h; s, m or h) and write each to
      <dir>/<id>.json (mode 0600). Prints id, name and expiry; --json prints ids and paths. Never a secret.
  invite --line [--force-stdout] [--count N] [--prefix P] [--ttl 1h] [--json]
      Print each invite as one line (ovis-invite:1:...) instead of writing files. THE LINE IS THE SECRET: it is
      printed only when stdout is a terminal, unless --force-stdout says to print it anyway.
  invite ... [--retention 24h] [--slots-from <batch>]
      --retention: how long a machine of the batch may go unseen before it is removed (0 keeps it; default 24h).
      --slots-from: new invites for every slot of that batch, under the same names (a rebuild); a machine that
      enrols with one replaces the slot's old key.
  invite --withdraw <invite> | invite --withdraw --batch <batch> [--json]
      Withdraw an open invite, or every open invite of a batch: it enrols nothing from then on.
  list [--all] [--json]
      Machines (name, id, state, cause, last seen, batch), open invites, and batches waiting for confirmation.
      Removed machines show with --all (always in --json).
  confirm <batch> [--yes] [--json]
      Show the batch's machines and fingerprints, ask on the terminal (or --yes), then confirm exactly that set.
  confirm --restored [--yes] [--json]
      While this controller's fleet records are older than its witness (a restored backup): show every machine,
      the ones removed after the backup marked, ask, then let them in (each removed one stays out: readmit it).
  remove <machine> [--json]
      Remove a machine (its id, fingerprint, or a name only it has): its key is revoked and its sessions end; its
      programs keep running on it. Removing a removed machine again forgets its record (its key stays refused).
  readmit <machine id> [--json]
      Let one removed key sign in again (after a restore).
  release <slot> [--json]
      Release a quarantined slot: its key is revoked, so the slot can be enrolled again (invite --slots-from).

exit codes: 0 ok, 1 failed, 2 usage, 3 unknown machine or batch, 4 server not running, 5 fleet not on,
6 refused, 7 changed since you looked, 8 the fleet needs OVIS_TOKEN (every PC that opens fleet machines needs
one: put OVIS_TOKEN=<token> in the plugin's config env and restart Ovis)
`;

export class Stop extends Error {
  /** `details`: machine-read fields the `--json` error carries beside its code and message (never a secret) */
  constructor(readonly exit: Exit, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

interface Options {
  readonly positional: string[];
  readonly flags: Set<string>;
  readonly values: Map<string, string>;
}

const VALUE_OPTIONS = new Set(["--count", "--prefix", "--ttl", "--out", "--phrase-file", "--retention", "--slots-from", "--batch"]);

function parseOptions(args: readonly string[], allowed: readonly string[]): Options {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!allowed.includes(name)) throw new Stop(FLEET_EXIT.usage, "usage", `unknown option ${name}`);
    if (VALUE_OPTIONS.has(name)) {
      const value = inline ?? args[++index];
      if (value === undefined || value === "") throw new Stop(FLEET_EXIT.usage, "usage", `${name} needs a value`);
      values.set(name, value);
    } else {
      if (inline !== undefined) throw new Stop(FLEET_EXIT.usage, "usage", `${name} takes no value`);
      flags.add(name);
    }
  }
  return { positional, flags, values };
}

/** `90s`, `30m`, `1h` or plain seconds. */
function seconds(text: string, option = "--ttl"): number {
  const match = /^(\d{1,6})([smhd]?)$/.exec(text);
  if (!match) throw new Stop(FLEET_EXIT.usage, "usage", `${option} ${text} is not a duration such as 90s, 30m, 1h or 7d`);
  return Number(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 } as const)[match[2] as "" | "s" | "m" | "h" | "d"];
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n");
}

/** What a fleet route answered, or the Stop its error means. */
export async function call<T>(io: Pick<FleetCommandIo, "origin" | "headers">, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...io.headers, "x-herdr-machine": "1" };
  // a write is the app's own: its header and origin (server/update-api.ts updateRequestAllowed), as `pair --approve` sends
  if (method !== "GET") Object.assign(headers, { "x-herdr-update": "1", origin: io.origin, "content-type": "application/json" });
  let response: Response;
  try {
    response = await fetch(`${io.origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Stop(FLEET_EXIT.not_running, "not_running", `Ovis is not running at ${io.origin}; start it first (ovis start)`);
  }
  let parsed: unknown;
  try { parsed = await response.json(); } catch { parsed = undefined; }
  if (response.ok && typeof parsed === "object" && parsed !== null) return parsed as T;
  const error = (parsed as { error?: { code?: unknown; message?: unknown; cause?: unknown } } | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
  const message = typeof error?.message === "string" ? error.message : `the server answered ${response.status}`;
  if (code === "owner_key_missing") throw new Stop(FLEET_EXIT.fleet_off, code, "The fleet is not on yet: run `ovis fleet on` first.");
  if (code === "fleet_token_required") throw new Stop(FLEET_EXIT.fleet_token_required, code, "The fleet needs OVIS_TOKEN on this server: put OVIS_TOKEN=<token> in the plugin's config env and restart Ovis. Nothing was changed.");
  if (code === "batch_changed") throw new Stop(FLEET_EXIT.changed, code, message);
  if (code === "unknown_batch" || code === "unknown_machine" || code === "unknown_invite" || code === "unknown_slot") throw new Stop(FLEET_EXIT.unknown, code, message);
  if (code === "restore_changed") throw new Stop(FLEET_EXIT.changed, code, message);
  // the server refused what was asked (a count over 256, a life under 60 s, a bad prefix): the command line's fault
  if (response.status === 400) throw new Stop(FLEET_EXIT.usage, code, message);
  if (response.status === 401 || response.status === 403 || response.status === 409 || response.status === 429) {
    if (response.status === 401 && io.headers["authorization"] === undefined) {
      throw new Stop(FLEET_EXIT.refused, code, "cannot read the server token: the server asks for OVIS_TOKEN and the plugin's config gives none. Run this as the user Ovis runs as, on its PC.");
    }
    // a machine that cannot be reached (the native route) says why: its row's cause, never a secret
    const cause = typeof error?.cause === "string" ? { cause: error.cause } : {};
    throw new Stop(FLEET_EXIT.refused, code, response.status === 401 ? `${message} (is OVIS_TOKEN in the plugin's config the server's token?)` : message, cause);
  }
  throw new Stop(FLEET_EXIT.failed, code, message);
}

interface InviteRow { id: string; slot: number; name: string; batch_id: string; exp: number; state: string }
interface BatchRow { batch_id: string; created_at: number; count: number; digest: string; machines: { machine_id: string; slot: number | null; name: string; fingerprint: string }[] }
export interface MachineRow {
  machine_id: string; name: string; fingerprint: string; batch_id: string | null; state: string; online: boolean; cause: string | null; since: number;
  removed_after_backup?: boolean; quarantined_after_backup?: boolean; alerts?: { count: number; last: number };
}
/** A machine's alerts as `list` marks them: `!3 (last 2026-11-13T12:00:00Z)`, or `-`. */
const alertMark = (row: MachineRow) => row.alerts ? `!${row.alerts.count} (last ${iso(row.alerts.last)})` : "-";
/** What a restored list marks on a row: removed or quarantined after the backup. */
const backupMark = (row: MachineRow) => row.removed_after_backup ? "Removed after this backup" : row.quarantined_after_backup ? "Quarantined after this backup" : "";
interface RestoreNotice { notice: string; reason: string; digest: string }

/** The one machine `wanted` names: its id (or fingerprint), else a name only one machine that is not removed has. */
export function findMachine(machines: readonly MachineRow[], wanted: string): MachineRow {
  const id = wanted.replace(/\s+/g, "").toLowerCase();
  let found = /^[0-9a-f]{32}$/.test(id) ? machines.filter((row) => row.machine_id === id) : [];
  if (!found.length) found = machines.filter((row) => row.name === wanted && row.state !== "revoked");
  if (found.length > 1) throw new Stop(FLEET_EXIT.unknown, "ambiguous_machine", `${found.length} machines are named ${wanted}; name one by its id (ovis fleet list).`);
  if (!found.length) throw new Stop(FLEET_EXIT.unknown, "unknown_machine", `No machine is ${wanted}.`);
  return found[0]!;
}

async function on(io: FleetCommandIo, args: readonly string[]): Promise<Exit> {
  const options = parseOptions(args, ["--phrase-file", "--json", "--restore"]);
  if (options.positional.length) throw new Stop(FLEET_EXIT.usage, "usage", "on takes no arguments (a recovery phrase never comes as one)");
  const json = options.flags.has("--json");
  const phraseFile = options.values.get("--phrase-file");
  if (options.flags.has("--restore")) {
    let phrase: string | null;
    if (phraseFile !== undefined) {
      const read = readPhraseFile(resolve(phraseFile));
      if ("reason" in read) throw new Stop(FLEET_EXIT.usage, "phrase_file", `${read.reason}. Nothing was made.`);
      phrase = read.phrase;
    } else {
      if (!io.stdinTTY) throw new Stop(FLEET_EXIT.usage, "phrase_needs_terminal", "--restore reads the recovery phrase at a terminal prompt, or from --phrase-file <path> (mode 0600). Nothing was made.");
      phrase = await io.ask("Recovery phrase of the fleet's owner key: ");
    }
    // the owner step's token rule holds for a restore too (server/fleet/gate.ts)
    if (io.headers["authorization"] === undefined) throw new Stop(FLEET_EXIT.fleet_token_required, "fleet_token_required", "The fleet needs OVIS_TOKEN on this server: put OVIS_TOKEN=<token> in the plugin's config env and restart Ovis. Nothing was made.");
    const restored = fleetOwnerRestore(io.stateDir, phrase ?? "");
    if (restored.kind === "refused") throw new Stop(FLEET_EXIT.usage, "not_restored", restored.reason);
    if (restored.kind === "failed") throw new Stop(FLEET_EXIT.failed, "owner_key_failed", restored.reason);
    if (restored.kind === "held") throw new Stop(FLEET_EXIT.fleet_token_required, "fleet_token_required", restored.reason);
    if (json) io.out(JSON.stringify({ fleet: "on", owner_public_key: restored.publicKey, restored: restored.kind === "restored" }));
    else io.out(restored.kind === "restored" ? `The fleet's owner key ${restored.publicKey} is restored from its recovery phrase.` : `The fleet's owner key ${restored.publicKey} is here already: nothing changed.`);
    return FLEET_EXIT.ok;
  }
  // a JSON answer never holds the phrase: there it goes into --phrase-file or nowhere
  // the phrase is shown before the key is put in place; a JSON answer never holds it. The plugin's config holds the token the
  // server runs with: none there, none on the server (server/fleet/gate.ts)
  const result = fleetOwner(io.stateDir, phraseFile === undefined ? undefined : resolve(phraseFile), !json && io.stdoutTTY ? io.out : undefined, io.headers["authorization"] !== undefined);
  if (result.kind === "held") throw new Stop(FLEET_EXIT.fleet_token_required, "fleet_token_required", result.reason);
  if (result.kind === "refused") throw new Stop(FLEET_EXIT.usage, "phrase_nowhere", json && phraseFile === undefined ? "with --json the recovery phrase goes only into --phrase-file <path>. Nothing was made." : result.reason);
  if (result.kind === "failed") throw new Stop(FLEET_EXIT.failed, "owner_key_failed", result.reason);
  if (json) io.out(JSON.stringify({ fleet: "on", owner_public_key: result.publicKey, created: result.kind === "made", phrase_file: "phraseFile" in result ? result.phraseFile : null }));
  else io.out(fleetOwnerText(result));
  return FLEET_EXIT.ok;
}

/**
 * Writes `bytes` to `path` as a new 0600 file, or into an empty regular file there; false for anything else there. A
 * write that fails part way (a full disk) leaves no part of the invite behind: a file it made is removed, an empty one
 * it filled is emptied again, and the error is thrown.
 */
export function writeInvite(path: string, bytes: Uint8Array): boolean {
  let fd: number;
  let made = true;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const held = lstatSync(path);
    if (!held.isFile() || held.size !== 0) return false;
    fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    made = false;
  }
  try {
    fchmodSync(fd, 0o600);
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at);
  } catch (error) {
    try { if (made) unlinkSync(path); else ftruncateSync(fd, 0); } catch { /* the write's own error is the one to report */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Why `dir` cannot take invite files, checked before anything is minted, or null: an existing folder must be one this
 * user can write into; a missing one must have a nearest existing parent folder it can write into (it is made only once
 * the mint succeeded, so a refused mint leaves nothing behind).
 */
function unwritable(dir: string): Stop | null {
  let at = dir;
  for (;;) {
    let held;
    try { held = statSync(at); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return new Stop(FLEET_EXIT.failed, "out_not_writable", `${at} cannot be read: no invite was minted.`);
      const parent = dirname(at);
      if (parent === at) return new Stop(FLEET_EXIT.failed, "out_not_writable", `${dir} has no folder to make it in: no invite was minted.`);
      at = parent;
      continue;
    }
    // --out naming a file is the command line's mistake; a folder this user cannot write is the system's answer
    if (!held.isDirectory()) return new Stop(FLEET_EXIT.usage, "out_not_folder", `${at} is not a folder: no invite was minted.`);
    try { accessSync(at, constants.W_OK | constants.X_OK); } catch { return new Stop(FLEET_EXIT.failed, "out_not_writable", `${at} is not writable: no invite was minted.`); }
    return null;
  }
}

async function invite(io: FleetCommandIo, args: readonly string[]): Promise<Exit> {
  const options = parseOptions(args, ["--count", "--prefix", "--ttl", "--out", "--line", "--force-stdout", "--json", "--retention", "--slots-from", "--withdraw", "--batch"]);
  const json = options.flags.has("--json");
  if (options.flags.has("--withdraw")) {
    const batch = options.values.get("--batch");
    const [id] = options.positional;
    if ((batch === undefined) === (id === undefined) || options.positional.length > 1 || ![...options.values.keys()].every((key) => key === "--batch")) {
      throw new Stop(FLEET_EXIT.usage, "usage", "invite --withdraw takes one invite id, or --batch <batch id>, and nothing else");
    }
    const which = batch === undefined ? { invite_id: id! } : { batch_id: batch };
    if (!/^[0-9a-f]{16}$/.test(Object.values(which)[0]!)) throw new Stop(FLEET_EXIT.usage, "usage", "an invite or batch id is 16 hex digits (ovis fleet list shows them)");
    const done = await call<{ withdrawn: string[] }>(io, "POST", "/api/fleet/invites/withdraw", which);
    if (json) io.out(JSON.stringify(done));
    else io.out(done.withdrawn.length ? `Withdrawn: ${done.withdrawn.join(", ")}. ${done.withdrawn.length === 1 ? "It enrols" : "They enrol"} nothing from now on.` : "No open invite was left to withdraw.");
    return FLEET_EXIT.ok;
  }
  if (options.values.has("--batch")) throw new Stop(FLEET_EXIT.usage, "usage", "--batch goes with --withdraw");
  if (options.positional.length) throw new Stop(FLEET_EXIT.usage, "usage", "invite takes no arguments");
  const out = options.values.get("--out");
  const line = options.flags.has("--line");
  if ((out === undefined) === !line) throw new Stop(FLEET_EXIT.usage, "usage", "invite needs --out <dir> or --line (one of them)");
  if (options.flags.has("--force-stdout") && !line) throw new Stop(FLEET_EXIT.usage, "usage", "--force-stdout goes with --line");
  // checked before anything is minted: a line is the secret, and it goes to a terminal unless told otherwise
  if (line && !io.stdoutTTY && !options.flags.has("--force-stdout")) {
    throw new Stop(FLEET_EXIT.usage, "secret_not_terminal", "--line prints each invite's secret, so only to a terminal; pass --force-stdout to print it anyway. Nothing was minted.");
  }
  const slotsFrom = options.values.get("--slots-from");
  if (slotsFrom !== undefined && (options.values.has("--count") || options.values.has("--prefix"))) throw new Stop(FLEET_EXIT.usage, "usage", "--slots-from takes the batch's slots and names: no --count or --prefix with it");
  if (slotsFrom !== undefined && !/^[0-9a-f]{16}$/.test(slotsFrom)) throw new Stop(FLEET_EXIT.usage, "usage", "--slots-from takes a batch id (16 hex digits; ovis fleet list shows them)");
  const countText = options.values.get("--count") ?? "1";
  if (!/^\d{1,3}$/.test(countText)) throw new Stop(FLEET_EXIT.usage, "usage", `--count ${countText} is not a number from 1 to 256`);
  const body: Record<string, unknown> = slotsFrom === undefined ? { count: Number(countText) } : { slots_from: slotsFrom };
  if (options.values.has("--prefix")) body["prefix"] = options.values.get("--prefix");
  if (options.values.has("--ttl")) body["life_s"] = seconds(options.values.get("--ttl")!);
  if (options.values.has("--retention")) body["retention_s"] = seconds(options.values.get("--retention")!, "--retention");
  const dir = out === undefined ? undefined : resolve(out);
  // checked before anything is minted, so the common failure (a wrong or read-only folder) leaves no invite open
  const cannot = dir === undefined ? null : unwritable(dir);
  if (cannot !== null) throw cannot;
  const minted = await call<{ batch_id: string; count: number; exp: number; invites: unknown[] }>(io, "POST", "/api/fleet/invites", body);
  // each file is the canonical bytes the invite reader takes (written back, a file reads as itself: enroll-vectors.test.ts)
  const files = minted.invites.map((entry) => {
    try {
      const parsed = parseInvite(new TextEncoder().encode(JSON.stringify(entry)));
      return { id: parsed.id, slot: parsed.slot, bytes: new TextEncoder().encode(JSON.stringify(parsed)) };
    } catch (error) {
      if (error instanceof InviteError) throw new Stop(FLEET_EXIT.failed, "invalid_invite", "The server answered an invite its own reader refuses; nothing was written.");
      throw error;
    }
  });
  let names = new Map<string, string>();
  try { names = new Map((await call<{ invites: InviteRow[] }>(io, "GET", "/api/fleet/invites")).invites.map((row) => [row.id, row.name])); }
  catch { /* the names are a courtesy: each invite's id and slot still say which it is */ }
  const name = (file: { id: string; slot: number }) => names.get(file.id) ?? `slot ${file.slot}`;
  const expires = iso(minted.exp * 1000);
  if (line) {
    const lines = files.map((file) => ({ id: file.id, slot: file.slot, name: name(file), line: inviteLine(file.bytes) }));
    if (json) io.out(JSON.stringify({ batch_id: minted.batch_id, exp: minted.exp, invites: lines }));
    else io.out([`# batch ${minted.batch_id}: ${lines.length} invite${lines.length === 1 ? "" : "s"}, valid until ${expires}. Each line is a secret.`, ...lines.flatMap((entry) => [`# ${entry.name} (${entry.id})`, entry.line])].join("\n"));
    return FLEET_EXIT.ok;
  }
  const written: { id: string; slot: number; name: string; path: string }[] = [];
  // the server has minted by now: every failure from here names the batch and what was not written, never a secret
  const unwritten: { id: string; why: "exists" | "failed" }[] = [];
  let folder = true;
  try { mkdirSync(dir!, { recursive: true, mode: 0o700 }); }
  catch { folder = false; }
  for (const file of files) {
    if (!folder) { unwritten.push({ id: file.id, why: "failed" }); continue; }
    const path = join(dir!, `${file.id}.json`);
    try {
      if (writeInvite(path, file.bytes)) written.push({ id: file.id, slot: file.slot, name: name(file), path });
      else unwritten.push({ id: file.id, why: "exists" });
    } catch { unwritten.push({ id: file.id, why: "failed" }); }
  }
  if (unwritten.length) {
    const failed = unwritten.some((entry) => entry.why === "failed");
    const n = unwritten.length;
    throw new Stop(failed ? FLEET_EXIT.failed : FLEET_EXIT.usage, failed ? "write_failed" : "file_exists",
      `Batch ${minted.batch_id}: ${written.length} of ${files.length} invite files written in ${dir}; ${n === 1 ? "invite" : "invites"} ${unwritten.map((entry) => entry.id).join(", ")} ${n === 1 ? "was" : "were"} not written (${failed ? "the folder or the disk refused the write" : "a file of that name already holds something"}) and ${n === 1 ? "expires" : "expire"} unused at ${expires}.`,
      { batch_id: minted.batch_id, exp: minted.exp, written: written.map((entry) => entry.path), unwritten: unwritten.map((entry) => entry.id) });
  }
  if (json) io.out(JSON.stringify({ batch_id: minted.batch_id, exp: minted.exp, invites: written }));
  else {
    io.out(`Batch ${minted.batch_id}: ${written.length} invite file${written.length === 1 ? "" : "s"} in ${dir} (mode 0600), valid until ${expires}.`);
    io.out(table([["ID", "NAME", "EXPIRES"], ...written.map((entry) => [entry.id, entry.name, expires])]));
  }
  return FLEET_EXIT.ok;
}

async function list(io: FleetCommandIo, args: readonly string[]): Promise<Exit> {
  const options = parseOptions(args, ["--all", "--json"]);
  if (options.positional.length) throw new Stop(FLEET_EXIT.usage, "usage", "list takes no arguments");
  const [{ machines, restore, fleet_state: fleetState }, { invites }, { batches }] = await Promise.all([
    call<{ machines: MachineRow[]; restore?: RestoreNotice; fleet_state?: string }>(io, "GET", "/api/fleet/machines"),
    call<{ invites: InviteRow[] }>(io, "GET", "/api/fleet/invites"),
    call<{ batches: BatchRow[] }>(io, "GET", "/api/fleet/batches"),
  ]);
  if (options.flags.has("--json")) {
    io.out(JSON.stringify({ machines, invites, batches, ...(restore ? { restore } : {}), ...fleetState === undefined ? {} : { fleet_state: fleetState } }));
    return FLEET_EXIT.ok;
  }
  if (restore) {
    io.out([`${restore.notice}. No machine signs in until you confirm this list (ovis fleet confirm --restored):`,
      table([["NAME", "ID", "FINGERPRINT", ""], ...machines.filter((row) => row.state !== "revoked").map((row) => [row.name || "-", row.machine_id, row.fingerprint, backupMark(row)])]), ""].join("\n"));
  }
  const shown = options.flags.has("--all") ? machines : machines.filter((row) => row.state !== "revoked");
  const lines: string[] = [];
  if (fleetState === "fleet_token_required") lines.push("The fleet is held: this server has no OVIS_TOKEN, so no machine signs in and nothing can be changed. Set it and restart Ovis.", "");
  lines.push(shown.length
    ? table([["NAME", "ID", "STATE", "CAUSE", "LAST SEEN", "ALERTS", "BATCH"], ...shown.map((row) => [row.name || "-", row.machine_id, row.state, row.cause ?? "-", row.online ? "online" : iso(row.since), alertMark(row), row.batch_id ?? "-"])])
    : "No machines.");
  if (shown.length < machines.length) lines.push(`(${machines.length - shown.length} removed machine${machines.length - shown.length === 1 ? "" : "s"} not shown; --all shows them)`);
  const open = invites.filter((row) => row.state === "unused");
  lines.push("", open.length ? `Open invites:\n${table([["ID", "NAME", "BATCH", "EXPIRES"], ...open.map((row) => [row.id, row.name, row.batch_id, iso(row.exp * 1000)])])}` : "No open invites.");
  for (const batch of batches) {
    lines.push("", `Batch ${batch.batch_id}: ${batch.count} machine${batch.count === 1 ? "" : "s"} waiting for confirmation (ovis fleet confirm ${batch.batch_id})`);
    for (const machine of batch.machines) lines.push(`  ${machine.name.padEnd(16)}  ${machine.fingerprint}`);
  }
  io.out(lines.join("\n"));
  return FLEET_EXIT.ok;
}

async function confirm(io: FleetCommandIo, args: readonly string[]): Promise<Exit> {
  const options = parseOptions(args, ["--yes", "--json", "--restored"]);
  const json = options.flags.has("--json");
  if (options.flags.has("--restored")) return confirmRestored(io, options);
  const [batchId] = options.positional;
  if (options.positional.length !== 1 || !/^[0-9a-f]{16}$/.test(batchId!)) throw new Stop(FLEET_EXIT.usage, "usage", "confirm takes one batch id (16 hex digits; `ovis fleet list` shows them)");
  const yes = options.flags.has("--yes");
  if (!yes && (json || !io.stdinTTY)) throw new Stop(FLEET_EXIT.usage, "confirm_needs_terminal", "confirm asks on a terminal; pass --yes to confirm the machines it shows without asking");
  const { batches } = await call<{ batches: BatchRow[] }>(io, "GET", "/api/fleet/batches");
  const batch = batches.find((row) => row.batch_id === batchId);
  if (!batch) {
    const { invites } = await call<{ invites: InviteRow[] }>(io, "GET", "/api/fleet/invites");
    const known = invites.some((row) => row.batch_id === batchId);
    throw new Stop(FLEET_EXIT.unknown, known ? "nothing_waiting" : "unknown_batch", known ? `No machine of batch ${batchId} waits for confirmation.` : `No batch has the id ${batchId}.`);
  }
  // what is confirmed is exactly this: its count and digest go with the request, and a change since is refused 409
  const shown = [`Batch ${batch.batch_id}: ${batch.count} machine${batch.count === 1 ? "" : "s"} waiting for confirmation. Compare each fingerprint with the one the machine shows (ovis-link status):`,
    table([["NAME", "FINGERPRINT"], ...batch.machines.map((machine) => [machine.name, machine.fingerprint])])].join("\n");
  if (json) io.err(shown);
  else io.out(shown);
  if (!yes) {
    const answer = await io.ask(`Confirm these ${batch.count} machine${batch.count === 1 ? "" : "s"}? Type yes to confirm: `);
    if ((answer ?? "").trim().toLowerCase() !== "yes") throw new Stop(FLEET_EXIT.refused, "not_confirmed", "Not confirmed: nothing changed.");
  }
  let done: { batch_id: string; activated: string[] };
  try { done = await call(io, "POST", `/api/fleet/batches/${batch.batch_id}/confirm`, { count: batch.count, digest: batch.digest }); }
  catch (error) {
    if (error instanceof Stop && error.exit === FLEET_EXIT.changed) {
      throw new Stop(FLEET_EXIT.changed, error.code, `Batch ${batch.batch_id} changed since you looked (a machine joined or left it): nothing was confirmed. Run \`ovis fleet confirm ${batch.batch_id}\` again and check its machines.`);
    }
    throw error;
  }
  if (json) io.out(JSON.stringify(done));
  else io.out(`Confirmed: ${done.activated.length} machine${done.activated.length === 1 ? " is" : "s are"} active.`);
  return FLEET_EXIT.ok;
}

/** `confirm --restored`: the list the controller shows while it holds its fleet as rolled back, confirmed by its digest. */
async function confirmRestored(io: FleetCommandIo, options: Options): Promise<Exit> {
  const json = options.flags.has("--json");
  if (options.positional.length) throw new Stop(FLEET_EXIT.usage, "usage", "confirm --restored takes no batch");
  const yes = options.flags.has("--yes");
  if (!yes && (json || !io.stdinTTY)) throw new Stop(FLEET_EXIT.usage, "confirm_needs_terminal", "confirm asks on a terminal; pass --yes to confirm the list it shows without asking");
  const { machines, restore } = await call<{ machines: MachineRow[]; restore?: RestoreNotice }>(io, "GET", "/api/fleet/machines");
  if (!restore) throw new Stop(FLEET_EXIT.unknown, "not_restored", "This controller's fleet is not held as restored: there is nothing to confirm.");
  const listed = machines.filter((row) => row.state !== "revoked");
  const shown = [`${restore.notice}. These machines get in once you confirm; each marked one stays out until you readmit it:`,
    table([["NAME", "ID", "FINGERPRINT", ""], ...listed.map((row) => [row.name || "-", row.machine_id, row.fingerprint, backupMark(row)])])].join("\n");
  if (json) io.err(shown);
  else io.out(shown);
  if (!yes) {
    const answer = await io.ask("Confirm this list? Type yes to confirm: ");
    if ((answer ?? "").trim().toLowerCase() !== "yes") throw new Stop(FLEET_EXIT.refused, "not_confirmed", "Not confirmed: nothing changed.");
  }
  const done = await call<{ generation: number; machines: number }>(io, "POST", "/api/fleet/restore/confirm", { digest: restore.digest });
  if (json) io.out(JSON.stringify(done));
  else io.out(`Confirmed: the fleet's records are current again; the machines not removed may sign in.`);
  return FLEET_EXIT.ok;
}

async function readmit(io: FleetCommandIo, args: readonly string[]): Promise<Exit> {
  const options = parseOptions(args, ["--json"]);
  const id = (options.positional[0] ?? "").replace(/\s+/g, "").toLowerCase();
  if (options.positional.length !== 1 || !/^[0-9a-f]{32}$/.test(id)) throw new Stop(FLEET_EXIT.usage, "usage", "readmit takes one machine id or fingerprint (32 hex digits)");
  const done = await call<{ machine_id: string; state: string }>(io, "POST", `/api/fleet/machines/${id}/readmit`, {});
  if (options.flags.has("--json")) io.out(JSON.stringify(done));
  else io.out(`Re-admitted ${done.machine_id}: its key may sign in again.`);
  return FLEET_EXIT.ok;
}

async function release(io: FleetCommandIo, args: readonly string[]): Promise<Exit> {
  const options = parseOptions(args, ["--json"]);
  const [slot] = options.positional;
  if (options.positional.length !== 1 || !/^(0|[1-9]\d{0,4})$/.test(slot!) || Number(slot) > 65535) throw new Stop(FLEET_EXIT.usage, "usage", "release takes one slot number (0-65535)");
  const done = await call<{ slot: number; revoked: string[] }>(io, "POST", `/api/fleet/slots/${slot}/release`, {});
  if (options.flags.has("--json")) io.out(JSON.stringify(done));
  else io.out(`Released slot ${done.slot}: its key ${done.revoked.join(", ")} is revoked; enrol it again with ovis fleet invite --slots-from <batch>.`);
  return FLEET_EXIT.ok;
}

async function remove(io: FleetCommandIo, args: readonly string[]): Promise<Exit> {
  const options = parseOptions(args, ["--json"]);
  if (options.positional.length !== 1) throw new Stop(FLEET_EXIT.usage, "usage", "remove takes one machine: its id, its fingerprint or its name");
  const { machines } = await call<{ machines: MachineRow[] }>(io, "GET", "/api/fleet/machines");
  const machine = findMachine(machines, options.positional[0]!);
  const removed = await call<{ machine_id: string; name: string; state: string }>(io, "DELETE", `/api/fleet/machines/${machine.machine_id}`);
  if (options.flags.has("--json")) io.out(JSON.stringify(removed));
  else if (removed.state === "forgotten") io.out(`Forgot the record of ${removed.name || removed.machine_id} (${machine.fingerprint}); its key stays refused.`);
  else io.out(`Removed ${removed.name || removed.machine_id} (${machine.fingerprint}): its key is revoked and its sessions ended; its programs keep running on it.`);
  return FLEET_EXIT.ok;
}

const COMMANDS: Record<string, (io: FleetCommandIo, args: readonly string[]) => Promise<Exit>> = {
  on, invite, list, confirm, remove, readmit, release,
};

/** One `ovis fleet` run: its exit code (FLEET_EXIT). */
export async function runFleet(args: readonly string[], io: FleetCommandIo): Promise<number> {
  const [name, ...rest] = args;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    (name === undefined ? io.err : io.out)(FLEET_HELP);
    return name === undefined ? FLEET_EXIT.usage : FLEET_EXIT.ok;
  }
  const command = COMMANDS[name];
  if (!command) { io.err(`ovis fleet: unknown command ${name}\n\n${FLEET_HELP}`); return FLEET_EXIT.usage; }
  if (rest.includes("--help") || rest.includes("-h")) { io.out(FLEET_HELP); return FLEET_EXIT.ok; }
  try {
    return await command(io, rest);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (rest.includes("--json")) io.out(JSON.stringify({ error: { code: error.code, message: error.message, ...error.details } }));
    else io.err(`ovis fleet ${name}: ${error.message}`);
    return error.exit;
  }
}
