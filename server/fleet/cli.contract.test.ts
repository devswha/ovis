/**
 * `ovis fleet` (scripts/plugin-fleet.ts) against a real server started with `port: 0` on a mkdtemp state folder: each
 * command through its routes, the rules for secrets on stdout, the confirm prompt and its 409, `remove` ending a live
 * machine session, the exit codes, and the command as `bun scripts/plugin.ts fleet ...` runs it. The last block runs the
 * built `ovis-link` (OVIS_LINK_BIN, else the crate's release build; skipped without one) through the whole flow.
 *
 * `ovis start <machine> ... -- <command>` and `ovis wait <machine> <terminal>` (scripts/plugin-start.ts, todo 32): through
 * the controller's `bridge` route and its loopback forward, over a machine session, to a stand-in bridge.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { FLEET_EXIT, runFleet, writeInvite } from "../../scripts/plugin-fleet.ts";
import type { FleetCommandIo } from "../../scripts/plugin-fleet.ts";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { startBunRelay } from "../../relay/bun.ts";
import { createServer } from "../index.ts";
import { rankLanAddresses } from "../relay/direct.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, deferred, relayFixture } from "../relay/test-helpers.ts";
import { parseInvite, parseInviteLine } from "./invites.ts";
import type { Invite } from "./invites.ts";
import { seedFromPhrase } from "./owner.ts";
import { machineFingerprint } from "./mux-ext.ts";
import { advertFrame, machineConnection, machineKey, pipeToTarget, testAdvert, turnFleetOn } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, FLEET_TEST_TOKEN, fleetTestServer } from "./test-server.ts";
import { ON_EXIT, runStart, runWait, START_HELD_EXIT, WAIT_ENDED_EXIT, WAIT_TIMEOUT_EXIT } from "../../scripts/plugin-start.ts";
import type { StartIo } from "../../scripts/plugin-start.ts";

// each test makes a few synced store writes: on a loaded disk they can pass bun's 5 s default
setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function folder(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-cli-${name}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const controllerKeys = generateKeyPair();
const CONTROLLER = { server_id: deriveServerId(controllerKeys.publicKey), server_public_key: exportPublicKey(controllerKeys.publicKey), relay: "wss://relay.ovis.example", direct: [] as string[] };

/** A server whose relay names CONTROLLER (no relay is dialed), with the fleet off until `fleet on`; the fleet test token unless `token` is given. */
function fleetServer(options: { token?: string } = {}) {
  const fixture = relayFixture(false, { token: options.token ?? FLEET_TEST_TOKEN, portal: undefined });
  cleanups.push(() => fixture.close());
  const relay = fixture.app.context.services.relay;
  const describeSpy = spyOn(relay, "fleetController").mockResolvedValue(CONTROLLER);
  cleanups.push(() => describeSpy.mockRestore());
  return { fixture, relay, origin: `http://127.0.0.1:${fixture.app.port}`, stateDir: fixture.stateDir };
}
type Server = ReturnType<typeof fleetServer>;

interface Run { code: number; out: string; err: string; asked: string[] }
/** One `ovis fleet` run against `server`; `answers` are what the terminal types at each question. */
async function fleet(server: Pick<Server, "origin" | "stateDir">, args: string[], options: { tty?: boolean; stdinTTY?: boolean; answers?: (() => Promise<string | null>)[]; headers?: Record<string, string> } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...options.answers ?? []];
  const io: FleetCommandIo = {
    origin: server.origin, headers: options.headers ?? FLEET_TEST_AUTH, stateDir: server.stateDir,
    stdoutTTY: options.tty ?? false, stdinTTY: options.stdinTTY ?? options.tty ?? false,
    out: (text) => out.push(text), err: (text) => err.push(text),
    ask: async (question) => { asked.push(question); return (await answers.shift()?.()) ?? null; },
  };
  const code = await runFleet(args, io);
  return { code, out: out.join("\n"), err: err.join("\n"), asked };
}
const json = (run: Run) => JSON.parse(run.out) as Record<string, unknown>;

/** Every form an invite's secret could be printed in. */
function secretForms(secret: string): string[] {
  const raw = Buffer.from(secret, "base64url");
  return [secret, raw.toString("hex"), raw.toString("base64"), raw.toString("latin1")];
}

/** Turns the fleet on (its phrase into a file) and mints `count` invite files; their parsed invites. */
async function minted(server: Server, count: number) {
  expect((await fleet(server, ["on", "--phrase-file", join(folder("phrase"), "phrase.txt")])).code).toBe(FLEET_EXIT.ok);
  const out = folder("invites");
  const run = await fleet(server, ["invite", "--count", String(count), "--prefix", "vm-", "--out", out, "--json"]);
  expect(run.code).toBe(FLEET_EXIT.ok);
  const answer = json(run) as { batch_id: string; invites: { id: string; path: string }[] };
  return { batch: answer.batch_id, out, run, invites: answer.invites.map((entry) => ({ ...entry, invite: parseInvite(readFileSync(entry.path)) })) };
}

/** A machine that enrols with `invite` on a live session of `server` and signs in. */
async function enrolled(server: Server, invite: { id: string; secret: string }) {
  const key = await machineKey();
  const machine = await machineConnection(server.fixture, server.relay.fleet, { machineSessions: server.relay.fleet, enrolment: server.relay.fleet });
  await machine.hello();
  await machine.enrollAndSignIn(key, invite);
  return { key, machine };
}

describe("ovis fleet on", () => {
  it("shows the recovery phrase only on a terminal or in a new 0600 file, never in JSON, and only once", async () => {
    const server = fleetServer();
    const owner = join(server.stateDir, "fleet", "owner.json");
    // no terminal and no file: nothing is made
    expect((await fleet(server, ["on"])).code).toBe(FLEET_EXIT.usage);
    const asJson = await fleet(server, ["on", "--json"], { tty: true });
    expect([asJson.code, (json(asJson).error as { code: string }).code]).toEqual([FLEET_EXIT.usage, "phrase_nowhere"]);
    expect(existsSync(owner)).toBe(false);
    // before it, an invite is refused as the fleet being off
    expect((await fleet(server, ["invite", "--out", folder("early")])).code).toBe(FLEET_EXIT.fleet_off);

    const phraseFile = join(folder("phrase"), "phrase.txt");
    const made = await fleet(server, ["on", "--phrase-file", phraseFile, "--json"]);
    expect(made.code).toBe(FLEET_EXIT.ok);
    expect(json(made)).toMatchObject({ fleet: "on", created: true, phrase_file: phraseFile });
    expect(statSync(phraseFile).mode & 0o777).toBe(0o600);
    const phrase = readFileSync(phraseFile, "utf8").trim();
    expect(phrase).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{1,4})+$/);
    expect(made.out + made.err).not.toContain(phrase);

    // a second run says the fleet is on and shows nothing, on a terminal too
    const keyBefore = readFileSync(owner, "utf8");
    const again = await fleet(server, ["on"], { tty: true });
    expect(again.code).toBe(FLEET_EXIT.ok);
    expect(again.out + again.err).not.toContain(phrase);
    expect(readFileSync(owner, "utf8")).toBe(keyBefore);
    expect(json(await fleet(server, ["on", "--json"]))).toMatchObject({ created: false, phrase_file: null });
  });

  it("shows the phrase on a terminal when it makes the key there", async () => {
    const server = fleetServer();
    const run = await fleet(server, ["on"], { tty: true });
    expect(run.code).toBe(FLEET_EXIT.ok);
    // the phrase printed is the one that gives back the key's own seed
    const { seed } = JSON.parse(readFileSync(join(server.stateDir, "fleet", "owner.json"), "utf8")) as { seed: string };
    const shown = (run.out.match(/[0-9A-Z]{4}(?:-[0-9A-Z]{1,4}){8,}/g) ?? []).map((token) => seedFromPhrase(token)).filter((found) => found !== undefined);
    expect(shown.map((found) => Buffer.from(found!).toString("base64url"))).toEqual([seed]);
  });
});

describe("ovis fleet invite", () => {
  it("writes one 0600 file per invite, the exact bytes the reader takes, and prints no secret", async () => {
    const server = fleetServer();
    const { invites, run, out } = await minted(server, 2);
    expect(invites).toHaveLength(2);
    expect(readdirSync(out).sort()).toEqual(invites.map((entry) => `${entry.id}.json`).sort());
    for (const entry of invites) {
      expect(entry.path).toBe(join(out, `${entry.id}.json`));
      expect(lstatSync(entry.path).mode & 0o777).toBe(0o600);
      // written back, the file reads as itself: the canonical bytes
      expect(readFileSync(entry.path, "utf8")).toBe(JSON.stringify(entry.invite));
      for (const form of secretForms(entry.invite.secret)) expect(run.out + run.err).not.toContain(form);
    }
    expect(Object.keys(json(run)).sort()).toEqual(["batch_id", "exp", "invites"]);
    for (const entry of (json(run) as { invites: Record<string, unknown>[] }).invites) expect(Object.keys(entry).sort()).toEqual(["id", "name", "path", "slot"]);
    // the human table names each one: id, name, expiry
    const human = await fleet(server, ["invite", "--out", out, "--ttl", "30m"]);
    expect(human.code).toBe(FLEET_EXIT.ok);
    const added = readdirSync(out).find((name) => !invites.some((entry) => name === `${entry.id}.json`))!;
    expect(human.out).toContain(added.slice(0, -".json".length));
    for (const form of secretForms(parseInvite(readFileSync(join(out, added))).secret)) expect(human.out + human.err).not.toContain(form);
  });

  it("refuses an existing file that holds anything, and a link, and fills an empty one with mode 0600", () => {
    const dir = folder("write");
    const held = join(dir, "held.json");
    writeFileSync(held, "kept", { mode: 0o644 });
    expect(writeInvite(held, new TextEncoder().encode("{}"))).toBe(false);
    expect(readFileSync(held, "utf8")).toBe("kept");
    const linked = join(dir, "linked.json");
    symlinkSync(join(dir, "elsewhere.json"), linked);
    expect(writeInvite(linked, new TextEncoder().encode("{}"))).toBe(false);
    expect(existsSync(join(dir, "elsewhere.json"))).toBe(false);
    const empty = join(dir, "empty.json");
    writeFileSync(empty, "", { mode: 0o644 });
    expect(writeInvite(empty, new TextEncoder().encode("{}"))).toBe(true);
    expect([readFileSync(empty, "utf8"), statSync(empty).mode & 0o777]).toEqual(["{}", 0o600]);
  });

  it("prints the line form only to a terminal or with --force-stdout, and each line reads as its invite", async () => {
    const server = fleetServer();
    await minted(server, 1);
    const listed = async () => (json(await fleet(server, ["list", "--json"])).invites as unknown[]).length;
    const before = await listed();
    const refused = await fleet(server, ["invite", "--line", "--count", "2"]);
    expect(refused.code).toBe(FLEET_EXIT.usage);
    // refused before anything was minted
    expect(await listed()).toBe(before);

    for (const run of [await fleet(server, ["invite", "--line", "--count", "2"], { tty: true }), await fleet(server, ["invite", "--line", "--force-stdout", "--count", "2"])]) {
      expect(run.code).toBe(FLEET_EXIT.ok);
      const lines = run.out.split("\n").filter((line) => line.startsWith("ovis-invite:1:"));
      expect(lines).toHaveLength(2);
      const ids = (json(await fleet(server, ["list", "--json"])).invites as { id: string; state: string }[]).filter((row) => row.state === "unused").map((row) => row.id);
      for (const line of lines) expect(ids).toContain(parseInviteLine(line).id);
    }
    const asJson = await fleet(server, ["invite", "--line", "--force-stdout", "--json"]);
    const [entry] = (json(asJson) as { invites: { id: string; line: string }[] }).invites;
    expect(parseInviteLine(entry!.line).id).toBe(entry!.id);
  });

  it("refuses an --out that is a file, a bad --ttl and both or neither of --out and --line, minting nothing", async () => {
    const server = fleetServer();
    await minted(server, 1);
    const file = join(folder("file"), "a-file");
    writeFileSync(file, "x");
    for (const args of [["invite", "--out", file], ["invite", "--out", folder("x"), "--ttl", "1 hour"], ["invite"], ["invite", "--out", folder("y"), "--line"], ["invite", "--count", "x", "--out", folder("z")]]) {
      expect((await fleet(server, args, { tty: true })).code, args.join(" ")).toBe(FLEET_EXIT.usage);
    }
    expect((json(await fleet(server, ["list", "--json"])).invites as unknown[])).toHaveLength(1);
  });
});

describe("ovis fleet invite: a folder it cannot write", () => {
  /** The invites of each mint, secrets included, as the server answered them: what must never be printed. */
  function capture(server: Server): Invite[] {
    const minted: Invite[] = [];
    const mint = server.relay.fleet.invites.mint.bind(server.relay.fleet.invites);
    const spy = spyOn(server.relay.fleet.invites, "mint").mockImplementation(async (...args) => {
      const answer = await mint(...args);
      minted.push(...answer.invites);
      return answer;
    });
    cleanups.push(() => spy.mockRestore());
    return minted;
  }
  /** Runs `act` when the command reads the invite list right after its mint (between the mint and the files). */
  function afterMint(server: Server, act: () => void) {
    const list = server.relay.fleet.invites.list.bind(server.relay.fleet.invites);
    const spy = spyOn(server.relay.fleet.invites, "list").mockImplementation((...args) => { act(); return list(...args); });
    cleanups.push(() => spy.mockRestore());
  }
  const unused = async (server: Server) => (json(await fleet(server, ["list", "--json"])).invites as { id: string; state: string }[]).filter((row) => row.state === "unused").map((row) => row.id).sort();

  it("refuses a folder it cannot write before anything is minted, and leaves no folder behind on a refused mint", async () => {
    const server = fleetServer();
    // the fleet off: refused, and the folder it would have made is not there
    const fresh = join(folder("fresh"), "invites");
    expect((await fleet(server, ["invite", "--out", fresh])).code).toBe(FLEET_EXIT.fleet_off);
    expect(existsSync(fresh)).toBe(false);
    await minted(server, 1);
    const before = await unused(server);
    // a server 400 (over 256, under 60 s) is the command line's: usage, and still no folder
    for (const args of [["--count", "300"], ["--ttl", "30s"], ["--prefix", "a b"]]) {
      const run = await fleet(server, ["invite", "--out", fresh, ...args]);
      expect(run.code, args.join(" ")).toBe(FLEET_EXIT.usage);
    }
    expect(existsSync(fresh)).toBe(false);
    const readOnly = folder("read-only");
    chmodSync(readOnly, 0o500);
    cleanups.push(() => chmodSync(readOnly, 0o700));
    for (const out of [readOnly, join(readOnly, "inside")]) {
      const run = await fleet(server, ["invite", "--count", "2", "--out", out, "--json"]);
      expect(run.code).toBe(FLEET_EXIT.failed);
      expect((json(run).error as { code: string }).code).toBe("out_not_writable");
    }
    expect(await unused(server)).toEqual(before);
    expect(readdirSync(readOnly)).toEqual([]);
  });

  it("names the batch and the invites it could not write when the folder refuses after the mint, and prints no secret", async () => {
    const server = fleetServer();
    await minted(server, 1);
    const secrets = capture(server);
    const out = folder("closing");
    afterMint(server, () => chmodSync(out, 0o500));
    cleanups.push(() => chmodSync(out, 0o700));
    const run = await fleet(server, ["invite", "--count", "2", "--out", out, "--json"]);
    expect(run.code).toBe(FLEET_EXIT.failed);
    const error = json(run).error as { code: string; batch_id: string; written: string[]; unwritten: string[]; exp: number };
    expect(error.code).toBe("write_failed");
    expect(error.batch_id).toMatch(/^[0-9a-f]{16}$/);
    expect(error.written).toEqual([]);
    expect([...error.unwritten].sort()).toEqual(secrets.map((entry) => entry.id).sort());
    // the invites are open, by the ids the owner was told
    for (const id of error.unwritten) expect(await unused(server)).toContain(id);
    expect(readdirSync(out)).toEqual([]);
    for (const entry of secrets) for (const form of secretForms(entry.secret)) expect(run.out + run.err).not.toContain(form);
    // the human form says the same without --json
    chmodSync(out, 0o700);
    const human = await fleet(server, ["invite", "--count", "1", "--out", out]);
    expect(human.code).toBe(FLEET_EXIT.failed);
    expect(human.err).toContain(secrets.at(-1)!.id);
  });

  it("writes the files it can and names the one whose name is already taken", async () => {
    const server = fleetServer();
    await minted(server, 1);
    const secrets = capture(server);
    const out = folder("taken");
    // a folder appears at the second invite's file name between the mint and the writes
    afterMint(server, () => mkdirSync(join(out, `${secrets.at(-1)!.id}.json`)));
    const run = await fleet(server, ["invite", "--count", "2", "--out", out, "--json"]);
    expect(run.code).toBe(FLEET_EXIT.usage);
    const error = json(run).error as { code: string; batch_id: string; written: string[]; unwritten: string[] };
    expect(error.code).toBe("file_exists");
    expect(error.unwritten).toEqual([secrets[1]!.id]);
    expect(error.written).toEqual([join(out, `${secrets[0]!.id}.json`)]);
    expect(statSync(error.written[0]!).mode & 0o777).toBe(0o600);
    for (const entry of secrets) for (const form of secretForms(entry.secret)) expect(run.out + run.err).not.toContain(form);
  });
});

describe("ovis fleet list, confirm and remove", () => {
  it("lists a pending machine with its batch, asks before confirming, and confirms exactly what it showed", async () => {
    const server = fleetServer();
    const { batch, invites } = await minted(server, 2);
    const { key } = await enrolled(server, invites[0]!.invite);
    const listed = json(await fleet(server, ["list", "--json"])) as { machines: { machine_id: string; state: string; batch_id: string }[]; batches: { batch_id: string; count: number }[]; invites: unknown[] };
    expect(listed.machines).toEqual([expect.objectContaining({ machine_id: key.id, state: "pending", batch_id: batch })]);
    expect(listed.batches.map((row) => [row.batch_id, row.count])).toEqual([[batch, 1]]);
    const human = await fleet(server, ["list"]);
    expect(human.out).toContain(batch);
    expect(human.out).toContain(key.id.match(/.{4}/g)!.join(" "));
    for (const form of secretForms(invites[1]!.invite.secret)) expect(human.out).not.toContain(form);

    // no terminal and no --yes: nothing is asked or sent
    expect((await fleet(server, ["confirm", batch])).code).toBe(FLEET_EXIT.usage);
    // a terminal that does not answer yes confirms nothing
    for (const answer of ["no", "y", "yes please", ""]) {
      const declined = await fleet(server, ["confirm", batch], { tty: true, answers: [async () => answer] });
      expect([declined.code, declined.asked.length], answer).toEqual([FLEET_EXIT.refused, 1]);
    }
    expect(server.relay.fleet.store.get(key.id)?.state).toBe("pending");
    const accepted = await fleet(server, ["confirm", batch], { tty: true, answers: [async () => "yes"] });
    expect(accepted.code).toBe(FLEET_EXIT.ok);
    expect(accepted.out).toContain(key.id.match(/.{4}/g)!.join(" "));
    expect(server.relay.fleet.store.get(key.id)?.state).toBe("active");
    expect(json(await fleet(server, ["list", "--json"])).batches).toEqual([]);
  });

  it("shows a batch that changed after it was shown as changed, and confirms nothing", async () => {
    const server = fleetServer();
    const { batch, invites } = await minted(server, 2);
    const first = await enrolled(server, invites[0]!.invite);
    let second: Awaited<ReturnType<typeof enrolled>> | undefined;
    // while the owner looks at one machine, a second one joins the batch
    const run = await fleet(server, ["confirm", batch], { tty: true, answers: [async () => { second = await enrolled(server, invites[1]!.invite); return "yes"; }] });
    expect(run.code).toBe(FLEET_EXIT.changed);
    // never retried: both still wait
    expect([server.relay.fleet.store.get(first.key.id)?.state, server.relay.fleet.store.get(second!.key.id)?.state]).toEqual(["pending", "pending"]);
    const asJson = await fleet(server, ["confirm", batch, "--yes", "--json"]);
    expect(asJson.code).toBe(FLEET_EXIT.ok);
    expect((json(asJson).activated as string[]).sort()).toEqual([first.key.id, second!.key.id].sort());
    expect((await fleet(server, ["confirm", batch, "--yes"])).code).toBe(FLEET_EXIT.unknown);
    expect((await fleet(server, ["confirm", "0123456789abcdef", "--yes"])).code).toBe(FLEET_EXIT.unknown);
  });

  it("removes a machine by name: its live session ends auth_revoked, its forward closes and the list hides it", async () => {
    const server = fleetServer();
    const { batch, invites } = await minted(server, 1);
    const { key, machine } = await enrolled(server, invites[0]!.invite);
    expect((await fleet(server, ["confirm", batch, "--yes"])).code).toBe(FLEET_EXIT.ok);
    expect(await bounded(server.relay.fleet.forwardReady(key.id))).toBeDefined();
    const name = server.relay.fleet.store.get(key.id)!.name;
    expect((await fleet(server, ["remove", "no-such-machine"])).code).toBe(FLEET_EXIT.unknown);

    const removed = await fleet(server, ["remove", name, "--json"]);
    expect(removed.code).toBe(FLEET_EXIT.ok);
    expect(json(removed)).toEqual({ machine_id: key.id, name, state: "revoked" });
    expect((await bounded(machine.error)).code).toBe("auth_revoked");
    await server.relay.fleet.idle();
    expect(server.relay.fleet.forward(key.id)).toBeUndefined();
    expect(server.relay.fleet.online(key.id)).toBe(false);
    // the roster (the PC list) has no row for it; the fleet list keeps the tombstone, shown with --all
    const pcs = (await (await fetch(`${server.origin}/api/machines`, { headers: FLEET_TEST_AUTH })).json()) as { machines?: { id?: string }[] };
    expect(Array.isArray(pcs.machines)).toBe(true);
    expect(JSON.stringify(pcs)).not.toContain(key.id);
    expect((await fleet(server, ["list"])).out).not.toContain(key.id);
    expect((await fleet(server, ["list", "--all"])).out).toContain(key.id);
    // its name no longer matches; its id still names it, and removing it again answers the same
    expect((await fleet(server, ["remove", name])).code).toBe(FLEET_EXIT.unknown);
    expect((await fleet(server, ["remove", key.id])).code).toBe(FLEET_EXIT.ok);
    // the key is refused for good: a fresh session of it is ended
    const back = await machineConnection(server.fixture, server.relay.fleet, { machineSessions: server.relay.fleet, enrolment: server.relay.fleet });
    await back.hello();
    await back.sendAuth(key);
    expect((await bounded(back.error)).code).toBe("auth_revoked");
  });
});

describe("ovis fleet remove: a name two machines share", () => {
  it("is refused unknown, and removes neither", async () => {
    const server = fleetServer();
    const [a, b] = [await machineKey(), await machineKey()];
    for (const key of [a, b]) server.relay.fleet.store.add({ machine_id: key.id, public_key: key.spki, name: "twin" });
    const run = await fleet(server, ["remove", "twin", "--json"]);
    expect([run.code, (json(run).error as { code: string }).code]).toEqual([FLEET_EXIT.unknown, "ambiguous_machine"]);
    expect([server.relay.fleet.store.get(a.id)?.state, server.relay.fleet.store.get(b.id)?.state]).toEqual(["pending", "pending"]);
    // each still goes by its id
    expect((await fleet(server, ["remove", a.id])).code).toBe(FLEET_EXIT.ok);
    expect(server.relay.fleet.store.get(b.id)?.state).toBe("pending");
  });
});

describe("ovis fleet exit codes", () => {
  it("says the server is not running, and refused when the token is wrong", async () => {
    const server = fleetServer({ token: "owner-token" });
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const origin = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    const down = await fleet({ origin, stateDir: server.stateDir }, ["list", "--json"]);
    expect([down.code, (json(down).error as { code: string }).code]).toEqual([FLEET_EXIT.not_running, "not_running"]);
    // a command with no token in the plugin's config cannot read the server token (todo 32's rule, true since todo 60)
    const tokenless = await fleet(server, ["list"], { headers: {} });
    expect(tokenless.code).toBe(FLEET_EXIT.refused);
    expect(tokenless.err).toContain("cannot read the server token");
    expect(tokenless.out).toBe("");
    expect((await fleet(server, ["list"], { headers: { authorization: "Bearer wrong" } })).code).toBe(FLEET_EXIT.refused);
    expect((await fleet(server, ["list"], { headers: { authorization: "Bearer owner-token" } })).code).toBe(FLEET_EXIT.ok);
    expect((await fleet(server, ["nothing"])).code).toBe(FLEET_EXIT.usage);
    expect((await fleet(server, ["list", "--frobnicate"])).code).toBe(FLEET_EXIT.usage);
    expect((await fleet(server, ["help"])).code).toBe(FLEET_EXIT.ok);
  });

  it("runs as `bun scripts/plugin.ts fleet` with the plugin's address and token", async () => {
    const server = fleetServer({ token: "owner-token" });
    const config = folder("config");
    writeFileSync(join(config, "env"), "OVIS_TOKEN=owner-token\n", { mode: 0o600 });
    const home = folder("home");
    mkdirSync(join(home, ".local", "state"), { recursive: true });
    const env = { PATH: process.env["PATH"] ?? "", HOME: home, TMPDIR: tmpdir(), HOST: "127.0.0.1", PORT: String(server.fixture.app.port),
      HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: folder("plugin-state"), OVIS_STATE_DIR: server.stateDir };
    const run = (...args: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, "..", "..", "scripts", "plugin.ts"), "fleet", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const on = run("on", "--phrase-file", join(folder("phrase"), "p.txt"), "--json");
    expect(await on.exited).toBe(FLEET_EXIT.ok);
    expect(JSON.parse(await new Response(on.stdout).text())).toMatchObject({ fleet: "on", created: true });
    expect(existsSync(join(server.stateDir, "fleet", "owner.json"))).toBe(true);
    const listed = run("list", "--json");
    expect(await listed.exited).toBe(FLEET_EXIT.ok);
    expect(Object.keys(JSON.parse(await new Response(listed.stdout).text())).sort()).toEqual(["batches", "invites", "machines"]);
    // a pipe is no terminal: the line form is refused, and the bare command prints its usage
    expect(await run("invite", "--line").exited).toBe(FLEET_EXIT.usage);
    expect(await run().exited).toBe(FLEET_EXIT.usage);
  });
});

const BUILD = join(import.meta.dir, "..", "..", "crates", "fleet-link", "target", "release", "ovis-link");
const BINARY = process.env["OVIS_LINK_BIN"] ?? BUILD;
const HOME_ADDRESSES = rankLanAddresses(networkInterfaces(), null);

/** Resolves once `read()` holds, looked at after each change in `dir`. */
async function until<T>(dir: string, read: () => T | undefined, ms = 30_000): Promise<T> {
  const result = deferred<T>();
  const look = () => { try { const value = read(); if (value !== undefined) result.resolve(value); } catch { /* mid-write */ } };
  const watcher = watch(dir, look);
  try { look(); return await bounded(result.promise, ms); } finally { watcher.close(); }
}

describe.skipIf((process.env["OVIS_LINK_BIN"] === undefined && !existsSync(BUILD)) || HOME_ADDRESSES.length === 0)("the owner's whole flow with the real ovis-link", () => {
  it("fleet on, invite --count 2, a real ovis-link enrols with one file, list shows it pending, confirm, active, remove: revoked", async () => {
    const stateDir = folder("e2e-state");
    const allow = { async limit() { return { success: true }; } };
    const relay = startBunRelay({ port: 0, hostname: "127.0.0.1", limits: { maxClientsPerServer: 12, maxSocketsPerAddress: 512 }, limiters: { perAddress: allow, global: allow } });
    cleanups.push(() => relay.stop());
    const service = new RelayService({
      stateDir, relay: "wss://relay.example", connect: (url) => new WebSocket(url.replace("wss://relay.example", `ws://127.0.0.1:${relay.port}`)),
      regionalRelays: [], ovisRelays: [], direct: { preferredPort: 0 },
    });
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: FLEET_TEST_TOKEN, tailscaleOwner: null, sidecar: false, relay: service });
    cleanups.push(async () => { await service.shutdown(); app.stop(); });
    const server = { origin: `http://127.0.0.1:${app.port}`, stateDir };
    expect((await fetch(`${server.origin}/api/relay/start`, { method: "POST", headers: { ...FLEET_TEST_AUTH, origin: server.origin, "x-herdr-update": "1" } })).status).toBe(200);
    await bounded((service as unknown as { directStarting: Promise<void> }).directStarting);

    expect((await fleet(server, ["on", "--phrase-file", join(folder("phrase"), "p.txt")])).code).toBe(FLEET_EXIT.ok);
    const out = folder("e2e-invites");
    const invited = await fleet(server, ["invite", "--count", "2", "--prefix", "e2e-", "--out", out, "--json"]);
    expect(invited.code).toBe(FLEET_EXIT.ok);
    const { batch_id: batch, invites } = json(invited) as { batch_id: string; invites: { id: string; path: string }[] };
    expect(invites).toHaveLength(2);
    // the installer's part, from the file the command wrote: fleet.json carries the invite, the owner block and a fresh key
    const invite = parseInvite(readFileSync(invites[0]!.path));
    const linkDir = folder("e2e-link");
    const machine = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const keyFile = join(linkDir, "machine.key");
    writeFileSync(keyFile, Buffer.from((await crypto.subtle.exportKey("jwk", machine.privateKey)).d!, "base64url"), { mode: 0o600 });
    const machineId = machineFingerprint(new Uint8Array(await crypto.subtle.exportKey("spki", machine.publicKey)));
    writeFileSync(join(linkDir, "fleet.json"), JSON.stringify({ v: 1, controller: { ...invite.controller, relay: `ws://127.0.0.1:${relay.port}` }, owner: invite.owner, machine_key_file: keyFile, invite: { id: invite.id, secret: invite.secret } }), { mode: 0o600 });
    writeFileSync(join(linkDir, "advert.json"), JSON.stringify({ v: 1, runtime_id: "rt-cli", boot_id: "boot-1", bridge_port: 9, bridge_token: "ab".repeat(32), versions: { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" } }), { mode: 0o600 });
    const agent = Bun.spawn([BINARY, "run", "--state", linkDir], { stdout: "ignore", stderr: "pipe" });
    cleanups.push(async () => { agent.kill(); await agent.exited; });
    const status = (): { state: string; error?: string } => JSON.parse(readFileSync(join(linkDir, "status.json"), "utf8"));
    // signed in pending (its AUTH_OK says so): docs/fleet-link.md section 1.6
    await until(linkDir, () => status().state === "pending-confirmation" ? true : undefined);

    const pending = json(await fleet(server, ["list", "--json"])) as { machines: { machine_id: string; state: string }[]; batches: { batch_id: string; count: number }[] };
    expect(pending.machines).toEqual([expect.objectContaining({ machine_id: machineId, state: "pending" })]);
    expect(pending.batches.map((row) => [row.batch_id, row.count])).toEqual([[batch, 1]]);
    expect((await fleet(server, ["confirm", batch, "--yes"])).code).toBe(FLEET_EXIT.ok);
    expect((json(await fleet(server, ["list", "--json"])).machines as { state: string }[])[0]!.state).toBe("active");
    // confirmed: the controller ends the pending session and the agent's next sign-in is not pending
    await until(linkDir, () => status().state === "connected" ? true : undefined);

    expect((await fleet(server, ["remove", machineId])).code).toBe(FLEET_EXIT.ok);
    // the agent hears auth_revoked, stops, and says so
    await until(linkDir, () => status().state !== "connected" ? true : undefined);
    const printed = Bun.spawnSync([BINARY, "status", "--state", linkDir, "--json"]);
    expect(printed.stdout.toString()).toContain("revoked");
    expect(service.fleet.online(machineId)).toBe(false);
  }, 90_000);
});

describe("ovis fleet: todo 31's commands", () => {
  it("on --restore puts the owner key back from its phrase (prompt or 0600 file, never an argument), and never replaces another", async () => {
    const server = fleetServer();
    const phraseFile = join(folder("phrase"), "phrase.txt");
    const made = await fleet(server, ["on", "--phrase-file", phraseFile, "--json"]);
    const publicKey = json(made)["owner_public_key"];
    const phrase = readFileSync(phraseFile, "utf8").trim();
    const owner = join(server.stateDir, "fleet", "owner.json");
    const original = readFileSync(owner);
    rmSync(owner);
    // never as an argument; never from a file others may read; never a mistyped phrase
    expect((await fleet(server, ["on", "--restore", phrase])).code).toBe(FLEET_EXIT.usage);
    chmodSync(phraseFile, 0o644);
    expect([(await fleet(server, ["on", "--restore", "--phrase-file", phraseFile])).code, existsSync(owner)]).toEqual([FLEET_EXIT.usage, false]);
    chmodSync(phraseFile, 0o600);
    const typo = await fleet(server, ["on", "--restore", "--json"], { stdinTTY: true, answers: [async () => phrase.replace(/^./, phrase[0] === "A" ? "B" : "A")] });
    expect([typo.code, (json(typo).error as { code: string }).code, existsSync(owner)]).toEqual([FLEET_EXIT.usage, "not_restored", false]);
    expect((await fleet(server, ["on", "--restore"], { stdinTTY: false })).code).toBe(FLEET_EXIT.usage);
    // from the prompt
    const restored = await fleet(server, ["on", "--restore", "--json"], { stdinTTY: true, answers: [async () => phrase] });
    expect([restored.code, json(restored)]).toEqual([FLEET_EXIT.ok, { fleet: "on", owner_public_key: publicKey, restored: true }]);
    expect(readFileSync(owner).equals(original) || JSON.parse(readFileSync(owner, "utf8")).public_key === publicKey).toBe(true);
    expect(statSync(owner).mode & 0o777).toBe(0o600);
    expect(restored.out + restored.err).not.toContain(phrase);
    // from the file, a second time: the same key is there, nothing changes
    expect(json(await fleet(server, ["on", "--restore", "--phrase-file", phraseFile, "--json"]))).toMatchObject({ restored: false });
    // another owner's phrase never replaces this one
    const other = fleetServer();
    const otherFile = join(folder("phrase"), "other.txt");
    await fleet(other, ["on", "--phrase-file", otherFile]);
    expect((await fleet(server, ["on", "--restore", "--phrase-file", otherFile])).code).toBe(FLEET_EXIT.usage);
    expect(JSON.parse(readFileSync(owner, "utf8")).public_key).toBe(publicKey);
  });

  it("invite --withdraw takes back one open invite or a batch's, --slots-from re-invites a batch's slots by name, --retention sets the batch's", async () => {
    const server = fleetServer();
    const { batch, invites } = await minted(server, 2);
    const withdrawn = await fleet(server, ["invite", "--withdraw", invites[0]!.id, "--json"]);
    expect([withdrawn.code, json(withdrawn)]).toEqual([FLEET_EXIT.ok, { withdrawn: [invites[0]!.id] }]);
    expect((await fleet(server, ["invite", "--withdraw", invites[0]!.id])).code).toBe(FLEET_EXIT.unknown);
    expect((await fleet(server, ["invite", "--withdraw"])).code).toBe(FLEET_EXIT.usage);
    // the second invite enrols a machine: a rebuild of the batch re-invites that slot under its name
    await enrolled(server, invites[1]!.invite);
    const again = await fleet(server, ["invite", "--slots-from", batch, "--retention", "7d", "--out", folder("rebuild"), "--json"]);
    expect(again.code).toBe(FLEET_EXIT.ok);
    const rebuilt = json(again) as { batch_id: string; invites: { name: string; slot: number }[] };
    expect(rebuilt.invites.map((entry) => [entry.slot, entry.name])).toEqual([[invites[1]!.invite.slot, `vm-${invites[1]!.invite.slot}`]]);
    const other = await fleet(server, ["invite", "--count", "2", "--out", folder("other"), "--json"]);
    const otherBatch = json(other) as { batch_id: string; invites: { id: string }[] };
    expect(json(await fleet(server, ["invite", "--withdraw", "--batch", otherBatch.batch_id, "--json"]))).toEqual({ withdrawn: otherBatch.invites.map((entry) => entry.id).sort() });
    expect(server.relay.fleet.store.document().batches.find((entry) => entry.id === rebuilt.batch_id)?.retention_s).toBe(7 * 86400);
    expect((await fleet(server, ["invite", "--slots-from", batch, "--count", "2", "--out", folder("bad")])).code).toBe(FLEET_EXIT.usage);
  });

  it("release frees a quarantined slot, readmit lets a removed key back, confirm --restored has nothing to confirm on a current fleet", async () => {
    const server = fleetServer();
    const { batch, invites } = await minted(server, 1);
    const { key } = await enrolled(server, invites[0]!.invite);
    expect((await fleet(server, ["confirm", batch, "--yes"])).code).toBe(FLEET_EXIT.ok);
    expect((await fleet(server, ["release", String(invites[0]!.invite.slot)])).code).toBe(FLEET_EXIT.refused);
    const copy = await machineConnection(server.fixture, server.relay.fleet, { machineSessions: server.relay.fleet, enrolment: server.relay.fleet });
    await copy.hello();
    copy.sendEnroll(await machineKey(), invites[0]!.invite);
    expect((await bounded(copy.error)).message).toBe("quarantined");
    const released = await fleet(server, ["release", String(invites[0]!.invite.slot), "--json"]);
    expect([released.code, json(released)]).toEqual([FLEET_EXIT.ok, { slot: invites[0]!.invite.slot, revoked: [key.id] }]);
    expect((await fleet(server, ["release", "70000"])).code).toBe(FLEET_EXIT.usage);
    const readmitted = await fleet(server, ["readmit", key.id, "--json"]);
    expect([readmitted.code, json(readmitted)]).toEqual([FLEET_EXIT.ok, { machine_id: key.id, state: "active" }]);
    expect((await fleet(server, ["readmit", key.id])).code).toBe(FLEET_EXIT.refused);
    expect((await fleet(server, ["confirm", "--restored", "--yes"])).code).toBe(FLEET_EXIT.unknown);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ovis start and ovis wait (todo 32): a controller, one active machine signed in over an in-process session whose
// `bridge` pipes go to `bridgePort`, and its advert naming `bridgeToken`.

async function bridgedController(bridgePort: number, bridgeToken: string, options: { signIn?: boolean } = {}) {
  const fixture = fleetTestServer({ portal: undefined });
  cleanups.push(() => fixture.close());
  turnFleetOn(fixture.stateDir);
  const fleet = fixture.app.context.services.relay.fleet;
  const key = await machineKey();
  fleet.store.add({ machine_id: key.id, public_key: key.spki, name: "vm-001" });
  fleet.store.setState(key.id, "active");
  if (options.signIn ?? true) {
    const machine = await machineConnection(fixture, fleet, { machineSessions: fleet }, { onPipe: (pipe) => pipeToTarget(pipe, bridgePort) });
    await machine.hello();
    await machine.signIn(key);
    machine.mux.enqueueControl(advertFrame({ ...testAdvert(["bridge"]), bridge_token: bridgeToken }));
    await bounded(machine.mux.measure());
  }
  return { fixture, origin: `http://127.0.0.1:${fixture.app.port}`, stateDir: fixture.stateDir };
}

interface StartRun { code: number; out: string; err: string }
async function startOrWait(verb: "start" | "wait", server: { origin: string; stateDir: string }, args: string[], io: Partial<StartIo> = {}): Promise<StartRun> {
  const out: string[] = [];
  const err: string[] = [];
  const all: StartIo = { origin: server.origin, headers: FLEET_TEST_AUTH, stateDir: server.stateDir, out: (text) => out.push(text), err: (text) => err.push(text), ...io };
  const code = await (verb === "start" ? runStart(args, all) : runWait(args, all));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const STAND_IN_TOKEN = "ab".repeat(32);

/** A stand-in for the machine's bridge server: the create route and the status stream, behind its token. */
function standInBridge(answer: Record<string, unknown>) {
  const creates: { authorization: string | null; body: Record<string, unknown> }[] = [];
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
  const snapshotSent = deferred<void>();
  let panes: Record<string, unknown>[] = [{ pane_id: "t3", terminal_id: "term-3", agent_status: "working", status_basis: "session" }];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, bun) {
      if (request.headers.get("authorization") !== `Bearer ${STAND_IN_TOKEN}`) return new Response("unauthorized", { status: 401 });
      const url = new URL(request.url);
      if (url.pathname === "/ws") return bun.upgrade(request) ? undefined : new Response("upgrade", { status: 426 });
      if (url.pathname === "/api/workspace/create" && request.method === "POST") {
        creates.push({ authorization: request.headers.get("authorization"), body: await request.json() as Record<string, unknown> });
        return Response.json(answer);
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.send(JSON.stringify({ type: "features", features: [] }));
        socket.send(JSON.stringify({ type: "snapshot", snapshot: { panes } }));
        snapshotSent.resolve();
      },
      message() {},
      close(socket) { sockets.delete(socket); },
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    port: server.port!, creates, snapshotSent: snapshotSent.promise,
    setPanes(next: Record<string, unknown>[]) { panes = next; },
    status(paneId: string, status: string) { for (const socket of sockets) socket.send(JSON.stringify({ type: "pane-status", pane_id: paneId, agent_status: status })); },
    exited(paneId: string) { for (const socket of sockets) socket.send(JSON.stringify({ type: "pane-exited", pane_id: paneId })); },
  };
}

describe("ovis start and ovis wait through the controller's bridge forward", () => {
  it("start posts the program and its first message to the machine's bridge, prints one JSON line and exits 0 when it was sent", async () => {
    const bridge = standInBridge({ pane_id: "t3", terminal: "t3", terminal_id: "term-3", first_message: { state: "sent", ready_by: "root" } });
    const controller = await bridgedController(bridge.port, STAND_IN_TOKEN);
    const run = await startOrWait("start", controller, ["vm-001", "--cwd", "/tmp", "--env", "A=1", "--message", "hi", "--", "sh", "-c", "echo hi"]);
    expect([run.code, run.err]).toEqual([0, ""]);
    expect(JSON.parse(run.out)).toEqual({ terminal: "t3", pane_id: "t3", first_message: { state: "sent", ready_by: "root" } });
    expect(bridge.creates).toEqual([{ authorization: `Bearer ${STAND_IN_TOKEN}`, body: {
      program: { argv: ["sh", "-c", "echo hi"] }, cwd: "/tmp", env: { A: "1" }, first_message: "hi", first_message_wait_ms: 30_000,
    } }]);
    // the bridge token went into one request header only: nothing printed holds it
    expect(run.out + run.err).not.toContain(STAND_IN_TOKEN);
    const agent = await startOrWait("start", controller, ["vm-001", "--agent", "codex", "--message", "go", "--wait", "2.5", "--", "codex"]);
    expect(agent.code).toBe(0);
    expect(bridge.creates[1]!.body).toEqual({ program: { argv: ["codex"], agent: "codex" }, first_message: "go", first_message_wait_ms: 2500 });
  });

  it("start exits 5 when the machine held the first message", async () => {
    const bridge = standInBridge({ pane_id: "t3", terminal: "t3", terminal_id: "term-3", first_message: { state: "held", code: "first_message_not_ready" } });
    const controller = await bridgedController(bridge.port, STAND_IN_TOKEN);
    const run = await startOrWait("start", controller, ["vm-001", "--message", "hi", "--", "stand-in"]);
    expect(run.code).toBe(START_HELD_EXIT);
    expect(JSON.parse(run.out)).toMatchObject({ first_message: { state: "held", code: "first_message_not_ready" } });
  });

  it("wait prints the shown state once it is one asked for, and exits 124 when the timeout passes first", async () => {
    const bridge = standInBridge({});
    const controller = await bridgedController(bridge.port, STAND_IN_TOKEN);
    const waiting = startOrWait("wait", controller, ["vm-001", "t3", "--until", "idle,blocked"]);
    await bounded(bridge.snapshotSent);
    bridge.status("t3", "done");
    bridge.status("t3", "idle");
    const run = await bounded(waiting);
    expect([run.code, run.err]).toEqual([0, ""]);
    expect(JSON.parse(run.out)).toEqual({ state: "idle", derived: false, basis: "session" });

    // the timeout's timer, injected: it fires once the stream showed only "working"
    let fire = (): void => {};
    const later = standInBridge({});
    const second = await bridgedController(later.port, STAND_IN_TOKEN);
    const timed = startOrWait("wait", second, ["vm-001", "term-3", "--until", "idle", "--timeout", "30"], { after: (ms, callback) => { expect(ms).toBe(30_000); fire = callback; return () => {}; } });
    await bounded(later.snapshotSent);
    fire();
    const timedOut = await bounded(timed);
    expect([timedOut.code, timedOut.out]).toEqual([WAIT_TIMEOUT_EXIT, ""]);
    expect(timedOut.err).toContain("did not show idle");
  });

  it("wait exits 3 when the terminal's program ends by itself before it shows a state asked for, with no --timeout", async () => {
    const bridge = standInBridge({});
    const controller = await bridgedController(bridge.port, STAND_IN_TOKEN);
    const waiting = startOrWait("wait", controller, ["--json", "vm-001", "t3", "--until", "idle"]);
    await bounded(bridge.snapshotSent);
    // another pane's end is not this one's
    bridge.exited("t9");
    bridge.exited("t3");
    const run = await bounded(waiting);
    expect([run.code, run.out]).toEqual([WAIT_ENDED_EXIT, ""]);
    expect(JSON.parse(run.err)).toEqual({ error: { origin: "ovis wait", code: "terminal_ended", message: "t3 ended before it showed idle", exit_code: WAIT_ENDED_EXIT } });
  });

  it("wait answers at once for a state the snapshot already shows, and names a terminal the machine does not have", async () => {
    const bridge = standInBridge({});
    const controller = await bridgedController(bridge.port, STAND_IN_TOKEN);
    expect(JSON.parse((await startOrWait("wait", controller, ["vm-001", "t3", "--until", "working"])).out)).toEqual({ state: "working", derived: false, basis: "session" });
    const missing = await startOrWait("wait", controller, ["--json", "vm-001", "t9", "--until", "idle"]);
    expect([missing.code, (JSON.parse(missing.err) as { error: { code: string } }).error.code]).toEqual([ON_EXIT.unknown, "unknown_terminal"]);
  });

  it("refuse their own command lines, an unknown or unreachable machine, and a caller without the token, with their own exit codes", async () => {
    const bridge = standInBridge({});
    const controller = await bridgedController(bridge.port, STAND_IN_TOKEN);
    expect((await startOrWait("start", controller, ["vm-001", "sh"])).code).toBe(ON_EXIT.usage);
    expect((await startOrWait("start", controller, ["vm-001", "--wait", "5", "--", "sh"])).code).toBe(ON_EXIT.usage);
    expect((await startOrWait("start", controller, ["vm-001", "--env", "NOEQUALS", "--", "sh"])).code).toBe(ON_EXIT.usage);
    expect((await startOrWait("wait", controller, ["vm-001", "t3", "--until", "asleep"])).code).toBe(ON_EXIT.usage);
    expect((await startOrWait("wait", controller, ["vm-001", "t3"])).code).toBe(ON_EXIT.usage);
    const unknown = await startOrWait("start", controller, ["vm-9999", "--", "sh"]);
    expect([unknown.code, unknown.err]).toEqual([ON_EXIT.unknown, "ovis start: No machine is vm-9999."]);
    expect((await startOrWait("start", controller, ["vm-001", "--", "sh"], { headers: {} })).code).toBe(ON_EXIT.refused);
    expect(bridge.creates).toEqual([]);
    const offline = await bridgedController(bridge.port, STAND_IN_TOKEN, { signIn: false });
    const unreachable = await startOrWait("wait", offline, ["--json", "vm-001", "t3", "--until", "idle"]);
    expect(unreachable.code).toBe(ON_EXIT.unreachable);
    expect(JSON.parse(unreachable.err)).toMatchObject({ error: { origin: "ovis wait", code: "machine_unreachable", cause: "offline" } });
  });
});
