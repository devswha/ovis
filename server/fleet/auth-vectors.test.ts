/**
 * The machine sign-in of docs/fleet-link.md section 1 against server/fleet/vectors/auth.json. Every case's bytes go
 * through the codec with the fleet extension (server/fleet/mux-ext.ts), then through the step its `stage` names: the
 * verifier for signatures and store states, a live session (server/relay/session.ts on a server started with
 * `port: 0`) for what the controller's session refuses, and a machine's own engine for what a machine refuses from
 * its controller. A case no step handles fails, so a vector added later cannot pass untested.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, FrameType, isExtensionFrame, LIMITS_V1, MuxProtocolError } from "../../shared/relay-mux.ts";
import type { SessionError } from "../../shared/relay-mux.ts";
import { bounded, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { fleetMuxExtension, machineFingerprint, pipeMuxExtension, verifyMachineAuth } from "./mux-ext.ts";
import { stateTag } from "./witness.ts";
import type { MachineAuth, MachineState } from "./mux-ext.ts";
import { machineConnection, machineKey, memoryDirectory } from "./test-helpers.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RelaySession } from "../relay/session.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";

type Obj = Record<string, unknown>;
interface Refuse { stage: "decode" | "verify" | "session"; kind: string; code: SessionError; message?: string }
interface Case {
  name: string; frame: string; type: number; stream_id: number; direction: "machine_to_controller" | "controller_to_machine";
  context: Obj & { state: "before_auth" | "after_auth"; selected: string[] }; bytes: string;
  expect: { parse?: Obj; refuse?: Refuse; effect?: string };
}
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "vectors", "auth.json"), "utf8")) as { derivations: Obj; cases: Case[] };
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const machineA = vectors.derivations["machine_a"] as { private_scalar_hex: string; spki: string; machine_id: string };

const cases = vectors.cases;

const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const fixture = () => { const made = relayFixture(); fixtures.push(made); return made; };

/**
 * The receiving end's codec: the controller filters request headers as server/relay/session.ts does. FLEET_STATE is read
 * on a machine session only (`pipe-stream` selected), as the other session frames of the fleet are.
 */
const decode = (entry: Case) => decodeFrame(fromHex(entry.bytes), entry.direction === "machine_to_controller", entry.frame === "FLEET_STATE" ? pipeMuxExtension : fleetMuxExtension);

/**
 * A live session on a fleet whose witness holds the case's witness key at the store's generation (todo 31), signed in by
 * machine A presenting the case's `seen_state`: AUTH_OK, or the refusal a newer verified generation gives.
 */
async function witnessed(entry: Case, auth: MachineAuth) {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-vectors-witness-"));
  const witnessDir = mkdtempSync(join(tmpdir(), "fleet-vectors-witness-dir-"));
  cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(witnessDir, { recursive: true, force: true }); });
  const key = await machineKey(machineA.private_scalar_hex, machineA.spki);
  const generation = Number(entry.context["store_generation"]);
  const witnessId = "ab".repeat(16);
  writeFileSync(join(witnessDir, `${witnessId}.json`), JSON.stringify({ v: 1, server_id: witnessId, generation, witness_key: Buffer.from(String(entry.context["witness_key_hex"]), "hex").toString("base64url"), removed: [] }), { mode: 0o600 });
  const store = new FleetStore({ stateDir });
  store.add({ machine_id: key.id, public_key: key.spki });
  store.setState(key.id, "active");
  store.update((document) => ({ document: { ...document, generation, witness_id: witnessId }, result: undefined }));
  const fleet = new Fleet({ stateDir, tokenConfigured: true, store, witnessDir });
  const serverId = String(entry.context["server_id"]);
  const connection = await machineConnection(fixture(), fleet, { machineSessions: fleet, serverId });
  await connection.hello();
  await connection.sendAuth(key, { serverId, ...(auth.seen_state ? { seen: auth.seen_state } : {}) });
  return bounded(Promise.race([connection.admitted.then(() => "signed in" as const), connection.error]));
}

function storeOf(entry: Case) {
  const key = String(entry.context["machine_public_key"]);
  const id = machineFingerprint(Buffer.from(key, "base64url"));
  const store = (entry.context["store"] ?? {}) as Record<string, MachineState>;
  return memoryDirectory(Object.entries(store).map(([machineId, state]) => {
    if (machineId !== id) throw new Error(`no key for ${machineId} in ${entry.name}`);
    return { machine_id: machineId, public_key: key, state };
  }));
}
const verify = (entry: Case, auth: MachineAuth) => verifyMachineAuth(storeOf(entry), auth, {
  nonce: Buffer.from(String(entry.context["nonce"]), "base64url"),
  serverId: String(entry.context["server_id"]),
  binding: fromHex(String(entry.context["binding_hex"])),
});

/**
 * The controller's count of machine sessions (server/fleet/sessions.ts) for a case whose context names `fleet`: `max`
 * places, `signed_in_others` of them held by other machines' sessions.
 */
function sessionsOf(entry: Case, key: { id: string; spki: string }) {
  const facts = entry.context["fleet"] as { max?: number; signed_in_others?: number; token?: boolean } | undefined;
  if (!facts) return {};
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-vectors-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const store = new FleetStore({ stateDir });
  store.add({ machine_id: key.id, public_key: key.spki });
  store.setState(key.id, "active");
  // `token: false`: a controller with no OVIS_TOKEN, whose fleet is held (server/fleet/gate.ts)
  const fleet = new Fleet({ stateDir, store, ...(facts.max === undefined ? {} : { max: facts.max }), tokenConfigured: facts.token !== false });
  for (let other = 0; other < (facts.signed_in_others ?? 0); other++) fleet.admit(other.toString(16).padStart(32, "f"), {} as RelaySession);
  return { fleet, machineSessions: fleet };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A live machine session on a fleet controller (or one without the fleet), brought to the case's state. */
async function live(entry: Case, fleet = true) {
  const key = await machineKey(machineA.private_scalar_hex, machineA.spki);
  const connection = await machineConnection(fixture(), fleet ? memoryDirectory([{ machine_id: key.id, public_key: key.spki, state: "active" }]) : null);
  if (entry.context.state === "after_auth") {
    await connection.hello();
    await connection.signIn(key);
  } else if (entry.frame !== "HELLO") await connection.hello(entry.context.selected, entry.context.selected);
  connection.sendBytes(fromHex(entry.bytes));
  return connection;
}

/** How a machine's own engine (signed in as a machine when the case says so) ends after the case's frame. */
function machineEnds(entry: Case): Promise<{ code: SessionError; message: string }> {
  const closed = Promise.withResolvers<{ code: SessionError; message: string }>();
  const engine = new MuxEngine({
    role: "client", clock: new TestClock(), send: async () => {}, close: () => {}, outboundWireByteLength: (bytes) => bytes.length,
    routingOverhead: 0, maxWireMessageBytes: 64 * 1024, extension: fleetMuxExtension, onClose: (error) => closed.resolve({ code: error.code, message: error.message }),
  });
  if (entry.context.state === "after_auth") engine.authenticateExtension(machineA.machine_id);
  engine.receive(fromHex(entry.bytes));
  return bounded(closed.promise);
}
/** What a machine's own engine does with frames its controller must never send. */
const machineRefuses = async (entry: Case): Promise<SessionError> => (await machineEnds(entry)).code;

describe("auth.json", () => {
  for (const entry of cases) {
    it(entry.name, async () => {
      const refuse = entry.expect.refuse;
      if (refuse?.stage === "decode") {
        let error: unknown;
        try { decode(entry); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(MuxProtocolError);
        expect((error as MuxProtocolError).code).toBe(refuse.code);
        return;
      }
      const frame = decode(entry);
      expect(frame.type).toBe(entry.type);
      expect(frame.stream_id).toBe(entry.stream_id);
      if (entry.frame === "WELCOME") {
        // `max_pipe_streams` is a key today's WELCOME codec ignores (docs/fleet-link.md section 1.2); todo 21 sends it
        const { max_pipe_streams, ...limits } = entry.expect.parse!["limits"] as Obj;
        expect(max_pipe_streams).toBe(16);
        expect(frame.payload).toEqual({ ...entry.expect.parse!, limits });
        expect(limits).toEqual({ ...LIMITS_V1 });
      } else expect(frame.payload).toEqual(entry.expect.parse!);

      const machineAuth = isExtensionFrame(frame) && frame.type === FrameType.AUTH ? frame.payload as MachineAuth : undefined;
      if (machineAuth && entry.context["witness_key_hex"] !== undefined) {
        // seen_state against the controller's witness (todo 31): a verified newer generation holds the fleet as restored
        expect(await witnessed(entry, machineAuth)).toEqual(refuse ? { code: refuse.code, message: refuse.message! } : "signed in");
        return;
      }
      if (entry.frame === "FLEET_STATE" && !refuse) {
        // the controller's tag: HMAC-SHA256(witness_key, server_id || generation as 8 bytes big-endian)
        const state = frame.payload as { generation: number; tag: string };
        expect(stateTag(fromHex(String(entry.context["witness_key_hex"])), String(entry.context["server_id"]), state.generation).toString("base64url")).toBe(state.tag);
        return;
      }
      if (machineAuth && entry.context["fleet"] && refuse) {
        // the signature holds over the case's own session; the count refuses it on a live one, signed for that session
        expect(await verify(entry, machineAuth) as unknown).toEqual({ machineId: machineAuth.machine_id });
        const key = await machineKey(machineA.private_scalar_hex, machineA.spki);
        const counted = sessionsOf(entry, key);
        const connection = await machineConnection(fixture(), counted.fleet!, { machineSessions: counted.machineSessions! });
        await connection.hello();
        await connection.sendAuth(key);
        expect(await bounded(connection.error)).toEqual({ code: refuse.code, message: refuse.message! });
        expect(connection.frames).not.toContain(FrameType.AUTH_OK);
        return;
      }
      if (machineAuth && entry.context["store"] && (refuse === undefined || refuse.stage === "verify" || refuse.code === "auth_revoked" || refuse.message === "unknown")) {
        const result = await verify(entry, machineAuth);
        expect(result as unknown).toEqual(refuse ? { code: refuse.code, cause: refuse.message } : { machineId: machineAuth.machine_id });
        return;
      }
      if (entry.direction === "controller_to_machine") {
        if (!refuse && entry.frame === "SESSION_ERROR") {
          // the machine ends the session with the controller's code and its cause
          expect(await machineEnds(entry)).toEqual(entry.expect.parse as { code: SessionError; message: string });
          return;
        }
        if (!refuse) {
          // AUTH_OK and WELCOME: the machine reads them; nothing to refuse
          expect(["AUTH_OK", "WELCOME"]).toContain(entry.frame);
          return;
        }
        expect(await machineRefuses(entry)).toBe(refuse.code);
        return;
      }
      if (entry.frame === "HELLO") {
        const connection = await live(entry, entry.context["controller"] === undefined);
        if (refuse) {
          expect((await bounded(connection.error)).code).toBe(refuse.code);
          return;
        }
        // the controller keeps pipe-stream: the machine signs in on this session
        const key = await machineKey(machineA.private_scalar_hex, machineA.spki);
        expect(await connection.signIn(key)).toMatchObject({ machine_id: key.id, role: "machine" });
        return;
      }
      if (!refuse && entry.frame === "SESSION_ERROR") {
        // a machine that ends its session: the controller closes the carrier
        const connection = await live(entry);
        await bounded(connection.closed);
        expect(connection.session.mux.active).toBe(false);
        return;
      }
      if (refuse?.stage === "session") {
        const connection = await live(entry);
        const error = await bounded(connection.error);
        expect(error.code).toBe(refuse.code);
        if (refuse.message !== undefined) expect(error.message).toBe(refuse.message);
        return;
      }
      throw new Error(`no step handles ${entry.name}`);
    });
  }
});
