/**
 * The fleet's owner key (docs/fleet-link.md, "Owner key and members"). It is made only by the explicit step that turns
 * the fleet on, `ovis-server fleet owner` (server/fleet/cli.ts), which shows its recovery phrase once, only on a terminal
 * or in a new 0600 file the caller names; a mint before that step is refused. Every invite carries the owner key's
 * public half and the controller as its first member, signed by it; the readers of an invite and of a machine's
 * fleet.json refuse a controller the owner key did not sign and any version they do not know.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { fleetOwner, runFleetCli } from "./cli.ts";
import { FleetFileError, parseFleetFile } from "./fleet-file.ts";
import { FleetInvites, FleetRouteError, InviteError, mintRequest, parseInvite } from "./invites.ts";
import type { InviteController } from "./invites.ts";
import { createOwnerKey, memberBytes, ownerKeyPath, ownerVerifies, recoveryPhrase, seedFromPhrase } from "./owner.ts";
import { FleetStore } from "./store.ts";

// each test makes a few synced store writes: on a loaded disk they can pass bun's 5 s default
setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function controllerOf(): InviteController {
  const keys = generateKeyPair();
  return { server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.example", direct: [] };
}
function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function setup() {
  const stateDir = folder("fleet-owner-");
  const store = new FleetStore({ stateDir });
  return { stateDir, store, invites: new FleetInvites(store) };
}
/** One run of the command against `stateDir`, with what it printed. */
function command(stateDir: string, args: string[], isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runFleetCli(args, { stateDir, isTTY, tokenConfigured: true, out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const fleetFileOf = (invite: Record<string, unknown>) => Buffer.from(JSON.stringify({
  v: 1, controller: invite["controller"], owner: invite["owner"], machine_key_file: "/var/lib/ovis-link/machine.key",
}));
function fleetCode(bytes: Uint8Array): string | undefined {
  try { parseFleetFile(bytes); } catch (error) { if (error instanceof FleetFileError) return error.code; throw error; }
  return undefined;
}
/** The phrase in every form someone could find it: as shown, without dashes, in lower case. */
const phraseForms = (phrase: string) => [phrase, phrase.replaceAll("-", ""), phrase.toLowerCase()];

describe("turning the fleet on", () => {
  it("is required before any mint: a mint refuses owner_key_missing, naming the step, and reserves nothing", async () => {
    const { invites, store } = setup();
    let refused: FleetRouteError | undefined;
    try { await invites.mint(mintRequest({ count: 1 }), async () => controllerOf()); } catch (error) { if (error instanceof FleetRouteError) refused = error; }
    expect(refused?.code).toBe("owner_key_missing");
    expect(refused?.message).toContain("ovis-server fleet owner");
    expect(existsSync(store.path)).toBe(false);
  });

  it("writes the phrase only to the new 0600 file the caller named; it is in no other file, no log line and no later answer", async () => {
    const { invites, store, stateDir } = setup();
    const logged: string[] = [];
    for (const method of ["log", "error", "warn", "info"] as const) {
      const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
      cleanups.push(() => spy.mockRestore());
    }
    const phraseFile = join(folder("fleet-owner-phrase-"), "phrase.txt");
    const run = command(stateDir, ["owner", "--phrase-file", phraseFile]);
    expect(run.code).toBe(0);
    expect(statSync(phraseFile).mode & 0o777).toBe(0o600);
    const phrase = readFileSync(phraseFile, "utf8").trim();
    expect(phrase).toMatch(/^[0-9A-Z]{4}(?:-[0-9A-Z]{1,4}){13}$/);
    const path = ownerKeyPath(store.path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Buffer.from(seedFromPhrase(phrase)!).toString("base64url")).toBe((JSON.parse(readFileSync(path, "utf8")) as { seed: string }).seed);
    const answers = [JSON.stringify(await invites.mint(mintRequest({ count: 2 }), async () => controllerOf())), JSON.stringify(invites.list()), JSON.stringify(invites.batches())];
    const files = readdirSync(stateDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
    for (const form of phraseForms(phrase)) {
      for (const text of [run.out, run.err, ...answers, ...files, logged.join("\n")]) expect(text.includes(form)).toBe(false);
    }
  });

  it("happens once: a second run makes no second key and shows no phrase", () => {
    const { stateDir, store } = setup();
    const first = command(stateDir, ["owner"], true);
    expect(first.code).toBe(0);
    const before = readFileSync(ownerKeyPath(store.path));
    const again = command(stateDir, ["owner"], true);
    const phraseFile = join(folder("fleet-owner-phrase-"), "phrase.txt");
    const third = command(stateDir, ["owner", "--phrase-file", phraseFile]);
    expect([again.code, third.code]).toEqual([0, 0]);
    expect(readFileSync(ownerKeyPath(store.path)).equals(before)).toBe(true);
    // and the key maker itself never replaces a key that is there
    const held = createOwnerKey(ownerKeyPath(store.path));
    expect("existed" in held && held.existed).toBe(true);
    expect(readFileSync(ownerKeyPath(store.path)).equals(before)).toBe(true);
    const phrase = /\n {2}([0-9A-Z-]+)\n/.exec(first.out)![1]!;
    for (const run of [again, third]) for (const form of phraseForms(phrase)) expect(`${run.out}\n${run.err}`.includes(form)).toBe(false);
    expect(existsSync(phraseFile)).toBe(false);
  });

  it("shows the phrase on a terminal, on stdout only", () => {
    const { stateDir } = setup();
    const run = command(stateDir, ["owner"], true);
    expect(run.code).toBe(0);
    const phrase = /\n {2}([0-9A-Z-]+)\n/.exec(run.out)?.[1];
    expect(phrase && seedFromPhrase(phrase)).toBeTruthy();
    expect(run.err).toBe("");
  });

  it("is whole or nothing across a crash at each step (todo 31): never a key whose phrase was not placed, and a rerun finishes", () => {
    const cli = join(import.meta.dir, "cli.ts");
    for (const point of ["phrase_written", "phrase_placed", "key_placed"] as const) {
      const stateDir = folder("fleet-owner-crash-");
      const phraseFile = join(folder("fleet-owner-phrase-"), "phrase.txt");
      // a process killed at `point`, as a power cut or a kill -9 would stop it
      const script = `import { fleetOwner } from ${JSON.stringify(cli)}; fleetOwner(${JSON.stringify(stateDir)}, ${JSON.stringify(phraseFile)}, undefined, true, (at) => { if (at === ${JSON.stringify(point)}) process.kill(process.pid, "SIGKILL"); });`;
      const run = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      expect(run.signalCode, point).toBe("SIGKILL");
      const key = join(stateDir, "fleet", "owner.json");
      const keyThere = existsSync(key);
      const phraseThere = existsSync(phraseFile) && seedFromPhrase(readFileSync(phraseFile, "utf8")) !== undefined;
      // never a key without its phrase in place
      expect([point, keyThere && !phraseThere]).toEqual([point, false]);
      expect([point, keyThere, phraseThere]).toEqual(point === "phrase_written" ? [point, false, false] : point === "phrase_placed" ? [point, false, true] : [point, true, true]);
      // the same command again finishes the step (or finds it done): the key is the phrase's
      const again = fleetOwner(stateDir, phraseFile, undefined, true);
      expect(again.kind, point).toBe(point === "key_placed" ? "existed" : "made");
      const seed = seedFromPhrase(readFileSync(phraseFile, "utf8"))!;
      expect(JSON.parse(readFileSync(key, "utf8")).seed).toBe(Buffer.from(seed).toString("base64url"));
      // what the killed run left half written is gone after the rerun
      expect([point, [...readdirSync(dirname(phraseFile)), ...readdirSync(join(stateDir, "fleet"))].filter((name) => name.endsWith(".tmp"))]).toEqual([point, []]);
    }
  });

  it("removes the temporaries a crashed run left, and only those whose process is gone", () => {
    const stateDir = folder("fleet-owner-stale-");
    const phraseFile = join(folder("fleet-owner-phrase-"), "phrase.txt");
    const gone = Bun.spawnSync(["true"]).pid;
    mkdirSync(join(stateDir, "fleet"), { recursive: true, mode: 0o700 });
    const stale = [join(stateDir, "fleet", `owner.json.${gone}.0123456789ab.tmp`), `${phraseFile}.${gone}.0123456789ab.tmp`];
    const live = `${phraseFile}.${process.pid}.ba9876543210.tmp`;
    for (const file of [...stale, live]) writeFileSync(file, "half", { mode: 0o600 });
    expect(fleetOwner(stateDir, phraseFile, undefined, true).kind).toBe("made");
    expect(stale.map((file) => existsSync(file))).toEqual([false, false]);
    expect(existsSync(live)).toBe(true);
  });

  it("puts the phrase on the terminal before the key is placed: a failure while showing it makes no key", () => {
    const stateDir = folder("fleet-owner-show-");
    const shown: string[] = [];
    const failed = fleetOwner(stateDir, undefined, () => { throw new Error("the terminal went away"); }, true);
    expect([failed.kind, existsSync(join(stateDir, "fleet", "owner.json"))]).toEqual(["failed", false]);
    const made = fleetOwner(stateDir, undefined, (text) => { shown.push(text); expect(existsSync(join(stateDir, "fleet", "owner.json"))).toBe(false); }, true);
    expect(made.kind).toBe("made");
    expect(seedFromPhrase(shown.join("").trim().split(/\s+/).at(-1)!)).toBeDefined();
  });

  it("refuses, making nothing, with no terminal and no phrase file, or a phrase file that exists", () => {
    const { stateDir, store } = setup();
    const piped = command(stateDir, ["owner"], false);
    expect(piped.code).toBe(2);
    expect(existsSync(ownerKeyPath(store.path))).toBe(false);
    const taken = join(folder("fleet-owner-phrase-"), "phrase.txt");
    writeFileSync(taken, "someone else's");
    expect(command(stateDir, ["owner", "--phrase-file", taken]).code).toBe(2);
    expect(existsSync(ownerKeyPath(store.path))).toBe(false);
    expect(command(stateDir, ["owner", "--phrase", "x"]).code).toBe(2);
  });

  it("is the binary's `fleet` entry: run as a process with stdout piped it refuses, and with a phrase file it turns the fleet on", () => {
    const stateDir = folder("fleet-owner-process-");
    const env = { ...process.env, OVIS_STATE_DIR: stateDir, OVIS_TOKEN: "fleet-owner-test-token" };
    const cli = join(import.meta.dir, "cli.ts");
    // without OVIS_TOKEN the fleet is held (server/fleet/gate.ts): refused, nothing made, the phrase file not even opened
    const heldPhrase = join(folder("fleet-owner-held-"), "phrase.txt");
    const held = Bun.spawnSync([process.execPath, cli, "owner", "--phrase-file", heldPhrase], { env: { ...env, OVIS_TOKEN: "" }, stdout: "pipe", stderr: "pipe" });
    expect(held.exitCode).toBe(2);
    expect(held.stderr.toString()).toContain("fleet_token_required");
    expect(existsSync(heldPhrase)).toBe(false);
    expect(existsSync(join(stateDir, "fleet"))).toBe(false);
    const piped = Bun.spawnSync([process.execPath, cli, "owner"], { env, stdout: "pipe", stderr: "pipe" });
    expect(piped.exitCode).toBe(2);
    expect(existsSync(join(stateDir, "fleet", "owner.json"))).toBe(false);
    const phraseFile = join(folder("fleet-owner-phrase-"), "phrase.txt");
    const made = Bun.spawnSync([process.execPath, cli, "owner", "--phrase-file", phraseFile], { env, stdout: "pipe", stderr: "pipe" });
    expect(made.exitCode).toBe(0);
    const phrase = readFileSync(phraseFile, "utf8").trim();
    expect(made.stdout.toString()).not.toContain(phrase);
    expect(made.stderr.toString()).not.toContain(phrase);
    expect(existsSync(join(stateDir, "fleet", "owner.json"))).toBe(true);
  });

  it("has a recovery phrase that survives case and dashes, and refuses one with a typo", () => {
    const seed = new Uint8Array(32).map((_, index) => index * 7);
    const phrase = recoveryPhrase(seed);
    expect(Buffer.from(seedFromPhrase(phrase)!).equals(Buffer.from(seed))).toBe(true);
    expect(Buffer.from(seedFromPhrase(phrase.toLowerCase().replaceAll("-", " "))!).equals(Buffer.from(seed))).toBe(true);
    expect(seedFromPhrase(phrase.replace(/^./, (char) => (char === "A" ? "B" : "A")))).toBeUndefined();
  });
});

describe("the owner key in an invite", () => {
  async function minted() {
    const { invites, store } = setup();
    createOwnerKey(ownerKeyPath(store.path));
    const controller = controllerOf();
    return { controller, invite: (await invites.mint(mintRequest({ count: 1 }), async () => controller)).invites[0]! as unknown as Record<string, unknown> & { owner: Record<string, unknown> } };
  }

  it("names the controller as the first member, which may open and change the list, signed by the owner key", async () => {
    const { controller, invite } = await minted();
    const owner = invite.owner as { public_key: string; member: never; signature: string };
    expect(owner.member as unknown).toEqual({ v: 1, server_id: controller.server_id, server_public_key: controller.server_public_key, class: "opener", open: true, write: true });
    expect(ownerVerifies(Buffer.from(owner.public_key, "base64url"), memberBytes(owner.member), Buffer.from(owner.signature, "base64url"))).toBe(true);
    expect(parseInvite(Buffer.from(JSON.stringify(invite)))).toEqual(invite as never);
    expect(parseFleetFile(fleetFileOf(invite)).owner).toEqual(owner as never);
  });

  it("refuses a member record another key signed", async () => {
    const { invite } = await minted();
    const stranger = createOwnerKey(join(folder("fleet-owner-other-"), "owner.json")).key;
    const forged = { ...invite, owner: { ...invite.owner, signature: Buffer.from(stranger.sign(memberBytes(invite.owner["member"] as never))).toString("base64url") } };
    expect(() => parseInvite(Buffer.from(JSON.stringify(forged)))).toThrow(InviteError);
    expect(fleetCode(fleetFileOf(forged))).toBe("controller_not_member");
  });

  it("refuses a small-order owner key, whose (identity || 0) signature a lax check accepts over any message", async () => {
    const { invite } = await minted();
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const anything = new Uint8Array(64);
    anything[0] = 1;
    expect(ownerVerifies(identity, new TextEncoder().encode("any record at all"), anything)).toBe(false);
    const forged = { ...invite, owner: { ...invite.owner, public_key: Buffer.from(identity).toString("base64url"), signature: Buffer.from(anything).toString("base64url") } };
    expect(() => parseInvite(Buffer.from(JSON.stringify(forged)))).toThrow(InviteError);
    expect(fleetCode(fleetFileOf(forged))).toBe("controller_not_member");
  });

  it("refuses a controller key rotated without a new owner-signed record", async () => {
    const { invite } = await minted();
    const rotated = controllerOf();
    const moved = { ...invite, controller: { ...(invite["controller"] as object), server_id: rotated.server_id, server_public_key: rotated.server_public_key } };
    expect(() => parseInvite(Buffer.from(JSON.stringify(moved)))).toThrow(InviteError);
    expect(fleetCode(fleetFileOf(moved))).toBe("controller_not_member");
  });

  it("refuses an invite or a fleet.json without the owner key (nothing without one has shipped)", async () => {
    const { invite } = await minted();
    const { owner: _owner, ...bare } = invite;
    expect(() => parseInvite(Buffer.from(JSON.stringify(bare)))).toThrow(InviteError);
    expect(fleetCode(fleetFileOf(bare as never))).toBe("invalid_fleet");
  });

  it("refuses a version it does not know: of the invite, of fleet.json and of the member record", async () => {
    const { invite } = await minted();
    expect(() => parseInvite(Buffer.from(JSON.stringify({ ...invite, v: 2 })))).toThrow(InviteError);
    const memberV2 = { ...invite, owner: { ...invite.owner, member: { ...(invite.owner["member"] as object), v: 2 } } };
    expect(() => parseInvite(Buffer.from(JSON.stringify(memberV2)))).toThrow(InviteError);
    expect(fleetCode(fleetFileOf(memberV2))).toBe("invalid_fleet");
    const fileV2 = { ...(JSON.parse(fleetFileOf(invite).toString()) as object), v: 2 };
    expect(fleetCode(Buffer.from(JSON.stringify(fileV2)))).toBe("invalid_fleet");
  });
});
