/**
 * `ovis-server fleet owner [--phrase-file <path>]` (from source: `bun server/fleet/cli.ts owner ...`): turns this
 * controller's fleet on by making its owner key (server/fleet/owner.ts) in the state folder (OVIS_STATE_DIR, else the
 * default one), and shows the key's recovery phrase once. The phrase goes only to a terminal, or to the file
 * `--phrase-file` names, which must not exist yet and is made mode 0600; with neither, nothing is made. It never goes to
 * stderr, a log, an error or an HTTP answer, and a second run makes no second key and shows no phrase. Invites can be
 * minted only after this step (`owner_key_missing` before it). Like every fleet write it needs a token (server/fleet/gate.ts):
 * without OVIS_TOKEN it answers `fleet_token_required` and makes nothing.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { syncDirectory } from "../private-state.ts";
import { defaultStateDir } from "../update-state.ts";
import { createOwnerKey, loadOwnerKey, restoreOwnerKey, seedFromPhrase } from "./owner.ts";

const USAGE = "usage: ovis-server fleet owner [--phrase-file <path>]";

export interface FleetCliIo {
  readonly stateDir: string;
  /** whether stdout is a terminal */
  readonly isTTY: boolean;
  /** whether the server has a token (OVIS_TOKEN): without one nothing is made */
  readonly tokenConfigured: boolean;
  /** stdout; the only place the phrase is written besides --phrase-file */
  out(text: string): void;
  /** stderr: never the phrase */
  err(text: string): void;
}

/**
 * What turning the fleet on did: `existed` (nothing made, nothing shown), `made` (the phrase in `phraseFile`, or shown on
 * the terminal before the key was put in place), `refused` (nothing made: no terminal and no file, or the file exists)
 * or `failed` (a reason that never holds the phrase).
 */
export type FleetOwnerResult =
  | { readonly kind: "existed"; readonly publicKey: string }
  | { readonly kind: "made"; readonly publicKey: string; readonly phraseFile: string }
  | { readonly kind: "made"; readonly publicKey: string; readonly shown: true }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** The points of turning the fleet on, in their order (tests stop the process at each). */
export type FleetOwnerStep = "phrase_written" | "phrase_placed" | "key_placed";

/**
 * Turns the fleet of `stateDir` on (the rules above), whole or nothing across a crash (todo 31): the phrase is written and
 * synced FIRST, to a temporary file beside `phraseFile` (0600), linked under its name (never over a file) and its folder
 * synced; only then is the owner key linked in place. On a terminal (`show`), the phrase is written to it before the key
 * is linked. A crash before the phrase is placed leaves no key; one after leaves the phrase and maybe no key, and running
 * the step again with the same `phraseFile` finishes it from that phrase. So a key never exists whose phrase was never
 * written. `step` is told each point as it is passed.
 */
export function fleetOwner(stateDir: string, phraseFile: string | undefined, show: ((text: string) => void) | undefined, tokenConfigured: boolean, step: (point: FleetOwnerStep) => void = () => {}): FleetOwnerResult {
  if (!tokenConfigured) return { kind: "held", reason: "fleet_token_required: the fleet needs OVIS_TOKEN on this server. Set it, restart Ovis, then turn the fleet on. Nothing was made." };
  const path = join(stateDir, "fleet", "owner.json");
  // what a crashed run left half made: its temporary key and phrase files (their process is gone)
  removeStaleTemporaries(path);
  if (phraseFile !== undefined) removeStaleTemporaries(phraseFile);
  let held;
  try { held = loadOwnerKey(path); }
  catch (error) { return { kind: "failed", reason: `${path} is not an owner key (${error instanceof Error ? error.message : String(error)}); it is left as it is.` }; }
  if (held) return { kind: "existed", publicKey: held.publicKey };
  if (phraseFile === undefined && show === undefined) {
    return { kind: "refused", reason: "the recovery phrase is shown only on a terminal. Run it in one, or pass --phrase-file <path> to write it to a new file of mode 0600. Nothing was made." };
  }
  if (phraseFile !== undefined && existsSync(phraseFile)) {
    // a run that stopped after placing the phrase and before placing the key: finish it from that phrase
    const read = readPhraseFile(phraseFile);
    const seed = "phrase" in read ? seedFromPhrase(read.phrase) : undefined;
    if (!seed) return { kind: "refused", reason: `${phraseFile} exists; it must not exist yet. Nothing was made.` };
    try {
      const restored = restoreOwnerKey(path, seed);
      step("key_placed");
      return restored.kind === "other" ? { kind: "existed", publicKey: restored.key.publicKey } : { kind: "made", publicKey: restored.key.publicKey, phraseFile };
    } catch (error) {
      return { kind: "failed", reason: `the owner key cannot be made (${error instanceof Error ? error.message : String(error)}).` };
    } finally { seed.fill(0); }
  }
  let placed = false;
  try {
    const made = createOwnerKey(path, (phrase) => {
      if (phraseFile === undefined) { show!(`Recovery phrase (write it down and keep it safe; it is not shown again):\n\n  ${phrase}\n`); step("phrase_placed"); return; }
      writePhraseFile(phraseFile, phrase, step);
      placed = true;
    });
    if ("existed" in made) {
      if (placed) unlinkSync(phraseFile!);
      return { kind: "existed", publicKey: made.key.publicKey };
    }
    step("key_placed");
    return phraseFile === undefined ? { kind: "made", publicKey: made.key.publicKey, shown: true } : { kind: "made", publicKey: made.key.publicKey, phraseFile };
  } catch (error) {
    // no key was placed: a phrase this run placed belongs to no key and goes
    if (placed && !loadOwnerKey(path)) { try { unlinkSync(phraseFile!); } catch { /* reported below */ } }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { kind: "refused", reason: `cannot make ${phraseFile}: it must not exist yet. Nothing was made.` };
    return { kind: "failed", reason: `the owner key cannot be made (${error instanceof Error ? error.message : String(error)}); nothing was kept.` };
  }
}

/**
 * Removes `<path>.<pid>.<12 hex>.tmp` files beside `path` whose process is gone: what a run killed while writing the
 * owner key (server/private-state.ts) or the phrase (writePhraseFile) left. One of a live process is left alone.
 */
export function removeStaleTemporaries(path: string): readonly string[] {
  const name = basename(path);
  const removed: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dirname(path)); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.startsWith(`${name}.`)) continue;
    const match = /^\.(\d{1,10})\.[0-9a-f]{12}\.tmp$/.exec(entry.slice(name.length));
    if (!match) continue;
    const pid = Number(match[1]);
    let alive = pid === process.pid;
    if (!alive) { try { process.kill(pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
    if (alive) continue;
    try { unlinkSync(join(dirname(path), entry)); removed.push(entry); } catch { /* gone already */ }
  }
  return removed;
}

/** The phrase into a new 0600 file `path`: a synced temporary file beside it, linked under its name, the folder synced. */
function writePhraseFile(path: string, phrase: string, step: (point: FleetOwnerStep) => void): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      const bytes = Buffer.from(`${phrase}\n`);
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    step("phrase_written");
    linkSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch { /* gone already */ } }
  syncDirectory(dirname(path), process.platform);
  step("phrase_placed");
}

/**
 * The recovery phrase in `path` for `ovis fleet on --restore --phrase-file`: a regular file of this user, mode 0600 or
 * stricter, not a link, at most 1 KiB; undefined with the reason otherwise. The phrase never comes as an argument.
 */
export function readPhraseFile(path: string): { readonly phrase: string } | { readonly reason: string } {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return { reason: `cannot open ${path} (${(error as NodeJS.ErrnoException).code ?? "error"}); a link is refused` }; }
  try {
    const held = fstatSync(fd);
    if (!held.isFile()) return { reason: `${path} is not a regular file` };
    if (process.platform !== "win32" && (held.mode & 0o077) !== 0) return { reason: `${path} may be read by others: make it mode 0600` };
    if (held.size > 1024) return { reason: `${path} is larger than a recovery phrase` };
    const bytes = Buffer.alloc(1024);
    const read = readSync(fd, bytes, 0, 1024, 0);
    const phrase = bytes.subarray(0, read).toString("utf8").trim();
    bytes.fill(0);
    return { phrase };
  } finally { closeSync(fd); }
}

/**
 * `ovis fleet on --restore` (todo 31): the owner key back from its recovery phrase. Refused, making nothing, for a phrase
 * that is not one (its check bytes fail), and when another owner key is there already (never replaced).
 */
export function fleetOwnerRestore(stateDir: string, phrase: string): FleetOwnerResult | { readonly kind: "restored"; readonly publicKey: string } {
  const seed = seedFromPhrase(phrase);
  if (!seed) return { kind: "refused", reason: "that is not a recovery phrase of an owner key (a word is mistyped or missing). Nothing was made." };
  try {
    const result = restoreOwnerKey(join(stateDir, "fleet", "owner.json"), seed);
    if (result.kind === "other") return { kind: "refused", reason: `this controller holds another owner key (${result.key.publicKey}); it is never replaced. Nothing was made.` };
    return result.kind === "existed" ? { kind: "existed", publicKey: result.key.publicKey } : { kind: "restored", publicKey: result.key.publicKey };
  } catch (error) {
    return { kind: "failed", reason: `the owner key cannot be restored (${error instanceof Error ? error.message : String(error)}).` };
  } finally { seed.fill(0); }
}

/** The sentence each result is told with on a terminal or a log; the phrase only in the one made for a terminal. */
export function fleetOwnerText(result: Extract<FleetOwnerResult, { kind: "existed" | "made" }>): string {
  if (result.kind === "existed") return `The fleet is on: its owner key ${result.publicKey} exists. Its recovery phrase was shown once, when it was made.`;
  if ("phraseFile" in result) return `The fleet is on. Owner key ${result.publicKey}. Its recovery phrase is in ${result.phraseFile}: write it down, keep it safe, then delete that file. It is not shown again.`;
  return `The fleet is on. Owner key ${result.publicKey}. Its recovery phrase is the one shown above.`;
}

/** One run of the command; resolves with its exit code (0 done, 2 usage or refused, 1 failed). */
export function runFleetCli(args: readonly string[], io: FleetCliIo): number {
  if (args[0] !== "owner") { io.err(USAGE); return 2; }
  const rest = args.slice(1);
  let phraseFile: string | undefined;
  if (rest.length === 2 && rest[0] === "--phrase-file" && rest[1]) phraseFile = rest[1];
  else if (rest.length !== 0) { io.err(USAGE); return 2; }
  const result = fleetOwner(io.stateDir, phraseFile, io.isTTY ? io.out : undefined, io.tokenConfigured);
  if (result.kind === "refused" || result.kind === "held") { io.err(`ovis-server fleet owner: ${result.reason}`); return 2; }
  if (result.kind === "failed") { io.err(`ovis-server fleet owner: ${result.reason}`); return 1; }
  io.out(fleetOwnerText(result as Extract<FleetOwnerResult, { kind: "existed" | "made" }>));
  return 0;
}

/** The command as the process runs it: its arguments, this state folder, this terminal. */
export function main(): void {
  process.exitCode = runFleetCli(process.argv.slice(2), {
    stateDir: defaultStateDir(), isTTY: process.stdout.isTTY === true, tokenConfigured: (process.env["OVIS_TOKEN"] ?? "") !== "",
    out: (text) => process.stdout.write(`${text}\n`), err: (text) => process.stderr.write(`${text}\n`),
  });
}

if (import.meta.main) main();
