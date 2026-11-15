/**
 * The controller's side of enrolment against the shared vectors (docs/fleet-link.md section 4): every case of
 * enroll.json through the codec (server/fleet/mux-ext.ts) and, past it, through the invites of a real fleet store on a
 * mkdtemp state folder (server/fleet/invites.ts), with the store, the controller's clock and the earlier tries the case
 * names; the cases a session's state refuses run on a live RelaySession; every case of invite.json through the invite
 * file's reader. The vectors are written by `bun scripts/fleet-vectors.ts` from the TypeScript code, never by hand.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFrame, encodeExtensionFrame, isExtensionFrame, MuxProtocolError } from "../../shared/relay-mux.ts";
import type { ExtensionFrame } from "../../shared/relay-mux.ts";
import { writePrivateState } from "../private-state.ts";
import { bounded, relayFixture } from "../relay/test-helpers.ts";
import { enrollMessage, FleetInvites, InviteError, inviteKey, inviteLine, inviteLineBytes, parseInvite, parseInviteLine } from "./invites.ts";
import type { EnrollRequest } from "./invites.ts";
import { FleetFileError, parseFleetFile } from "./fleet-file.ts";
import { EnrollFrame, machineFingerprint, pipeMuxExtension } from "./mux-ext.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { machineConnection } from "./test-helpers.ts";

type Obj = Record<string, unknown>;
interface Case { name: string; frame: string; type: number | null; direction: string; context: Obj; bytes: string; expect: { parse?: Obj; refuse?: { stage: string; kind: string; code: string; message?: string } } }
interface File { derivations: Obj; cases: Case[] }
const load = (name: string): File => JSON.parse(readFileSync(join(import.meta.dir, "vectors", name), "utf8")) as File;
const ENROLL = load("enroll.json");
const INVITE = load("invite.json");
const FILES = load("machine-files.json");
const derivations = ENROLL.derivations as { invite: Record<string, string>; machine_enrolling: Record<string, string>; machine_second: Record<string, string> };
const bytesOf = (entry: Case) => Uint8Array.from(Buffer.from(entry.bytes, "hex"));
const hexBytes = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));

// each test makes a few synced store writes: on a loaded disk they can pass bun's 5 s default (as direct.contract.test.ts says)
setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function stateFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-enroll-vectors-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A store as a case's context describes it: the vector's invite (its public key, expiry and state) in batch `b0`, and for
 * a used invite the machine its first key made, pending.
 */
function storeFor(context: Obj): FleetStore {
  const stateDir = stateFolder();
  const described = context["store"] as { invite?: string; exp?: number; machine_public_key?: string };
  const usedBy = described.invite === "used" ? described.machine_public_key! : null;
  const now = Number(context["controller_now"]) * 1000;
  const machines = usedBy === null ? [] : [{
    machine_id: machineFingerprint(Buffer.from(usedBy, "base64url")), public_key: usedBy, state: "pending", slot: 3,
    invite_id: derivations.invite["invite_id"], runtime_id: null, name: "vm-3", created_at: now, updated_at: now,
  }];
  const invites = described.invite === undefined ? [] : [{
    id: derivations.invite["invite_id"], slot: 3, name: "vm-3", batch_id: "b0b0b0b0b0b0b0b0", public_key: derivations.invite["public_key_hex"],
    exp: described.exp, used_by: usedBy, created_at: now - 1000,
  }];
  writePrivateState(join(stateDir, "fleet", "machines.json"), { v: 1, machines, invites, batches: invites.length ? [{ id: "b0b0b0b0b0b0b0b0", created_at: now - 1000 }] : [] });
  return new FleetStore({ stateDir, now: () => now });
}

const decode = (bytes: Uint8Array) => decodeFrame(bytes, false, pipeMuxExtension);

describe("enroll.json: the invite key", () => {
  it("is derived from the secret and the invite id as section 4 says", () => {
    const { secret, invite_id: id, seed_hex: seed, public_key_hex: publicKey } = derivations.invite as Record<string, string>;
    const key = inviteKey(Buffer.from(secret!, "base64url"), id!);
    expect(Buffer.from(key.seed).toString("hex")).toBe(seed!);
    expect(Buffer.from(key.publicKey).toString("hex")).toBe(publicKey!);
  });

  it("signs the bytes of section 4: the accepted case's signature is the vector's", () => {
    const { secret, invite_id: id } = derivations.invite as Record<string, string>;
    const accept = ENROLL.cases.find((entry) => entry.name === "enroll/accept")!;
    const signed = accept.context["signed"] as Record<string, string>;
    const message = enrollMessage(hexBytes(signed["binding_hex"]!), Buffer.from(signed["machine_public_key"]!, "base64url"), id!);
    expect(Buffer.from(message).toString("hex")).toBe((ENROLL.derivations["enroll_message"] as Record<string, string>)["accept_hex"]!);
    expect(Buffer.from(inviteKey(Buffer.from(secret!, "base64url"), id!).sign(message)).toString("base64url")).toBe(accept.expect.parse!["signature"] as string);
  });
});

describe("enroll.json through the codec", () => {
  for (const entry of ENROLL.cases) {
    it(entry.name, () => {
      const refuse = entry.expect.refuse;
      if (refuse?.stage === "decode") {
        expect(() => decode(bytesOf(entry))).toThrow(MuxProtocolError);
        return;
      }
      const frame = decode(bytesOf(entry));
      expect(isExtensionFrame(frame)).toBe(true);
      expect((frame as ExtensionFrame).type).toBe(entry.type!);
      expect((frame as ExtensionFrame).payload).toEqual(entry.expect.parse!);
      // the canonical form: what this code writes is the vector's bytes
      expect(Buffer.from(encodeExtensionFrame(frame as ExtensionFrame, pipeMuxExtension)).toString("hex")).toBe(entry.bytes);
      expect([EnrollFrame.ENROLL, EnrollFrame.ENROLL_OK] as number[]).toContain(entry.type!);
    });
  }
});

describe("enroll.json through the controller's invites", () => {
  const checked = ENROLL.cases.filter((entry) => entry.frame === "ENROLL" && entry.direction === "machine_to_controller"
    && entry.context["state"] === "before_auth" && entry.expect.refuse?.stage !== "decode" && entry.context["fleet"] === undefined);
  it("covers every ENROLL a machine sends before AUTH that the codec reads", () => {
    expect(checked.map((entry) => entry.name).sort()).toEqual([
      "enroll/accept", "enroll/expired", "enroll/machine-key-not-on-curve", "enroll/other-machine-key", "enroll/replayed-on-another-session",
      "enroll/retry-same-key", "enroll/second-key", "enroll/sixth-try", "enroll/unknown-invite", "enroll/valid-past-tries", "enroll/wrong-secret",
    ]);
  });

  for (const entry of checked) {
    it(entry.name, async () => {
      const store = storeFor(entry.context);
      const now = Number(entry.context["controller_now"]) * 1000;
      const invites = new FleetInvites(store, { now: () => now });
      const binding = hexBytes(String((entry.context["verifier"] as Obj | undefined)?.["binding_hex"] ?? (entry.context["signed"] as Obj)["binding_hex"]));
      const request = entry.expect.parse as unknown as EnrollRequest;
      // the tries the case says came before: refused ones, each over another session's binding
      const tries = Number(entry.context["tries_before"]);
      for (let index = 0; index < tries; index++) expect(await invites.enroll(request, { binding: new Uint8Array(32).fill(index + 1) })).toMatchObject({ code: "auth_failed", cause: "signature" });
      const before = readFileSync(store.path);
      const result = await invites.enroll(request, { binding });
      const refuse = entry.expect.refuse;
      if (refuse === undefined) {
        expect(result).toEqual({ machineId: machineFingerprint(Buffer.from(String(request.machine_public_key), "base64url")) });
        const machine = store.machines().find((record) => record.public_key === request.machine_public_key);
        expect(machine?.state).toBe("pending");
        expect(machine?.invite_id).toBe(request.invite_id);
        return;
      }
      expect(result as unknown).toEqual({ code: refuse.code, cause: refuse.message });
      if (refuse.code === "auth_failed") expect(readFileSync(store.path).equals(before)).toBe(true);
      else {
        // a second key: the slot is quarantined, the first key's machine with it, and nothing of the second key is kept
        expect(store.machines().map((machine) => [machine.machine_id, machine.state])).toEqual([[derivations.machine_enrolling["machine_id"]!, "quarantined"]]);
        expect(readFileSync(store.path, "utf8")).not.toContain(String(request.machine_public_key));
      }
    });
  }
});

describe("enroll.json against a session's state", () => {
  async function session(token = true) {
    const stateDir = stateFolder();
    const fleet = new Fleet({ stateDir, store: new FleetStore({ stateDir }), tokenConfigured: token });
    const fixture = relayFixture(false, { stateDir });
    cleanups.push(() => fixture.close());
    return machineConnection(fixture, fleet, { machineSessions: fleet, enrolment: fleet });
  }
  for (const name of ["enroll/after-auth", "enroll/enroll-ok/from-machine"]) {
    it(`${name}: a machine's frame there ends the session protocol_error`, async () => {
      const entry = ENROLL.cases.find((candidate) => candidate.name === name)!;
      const machine = await session();
      await machine.hello();
      if (entry.context["state"] === "after_auth") {
        // signed in first: a machine of the store
        const store = (machine.session as unknown as { options: { fleet: Fleet } }).options.fleet.store;
        const { machineKey } = await import("./test-helpers.ts");
        const key = await machineKey();
        store.add({ machine_id: key.id, public_key: key.spki });
        await machine.signIn(key);
      }
      machine.sendBytes(bytesOf(entry));
      expect((await bounded(machine.error)).code as string).toBe(entry.expect.refuse!.code);
    });
  }
  it("enroll/fleet-token-required: a controller with no token ends the session before the invite is looked at", async () => {
    const entry = ENROLL.cases.find((candidate) => candidate.name === "enroll/fleet-token-required")!;
    expect(entry.context["fleet"]).toEqual({ token: false });
    const machine = await session(false);
    const store = (machine.session as unknown as { options: { fleet: Fleet } }).options.fleet.store;
    await machine.hello();
    machine.sendBytes(bytesOf(entry));
    expect(await bounded(machine.error) as unknown).toEqual({ code: entry.expect.refuse!.code, message: entry.expect.refuse!.message! });
    expect(existsSync(store.path)).toBe(false);
  });
  it("enroll/to-machine: an ENROLL the controller sends is refused by the machine", () => {
    const entry = ENROLL.cases.find((candidate) => candidate.name === "enroll/to-machine")!;
    expect(entry.expect.refuse).toMatchObject({ code: "protocol_error" });
    // the machine's own reader (crates/fleet-link) refuses it; on this side the controller never writes one
    expect(() => encodeExtensionFrame(decode(bytesOf(entry)) as ExtensionFrame, pipeMuxExtension)).not.toThrow();
  });
});

describe("invite.json", () => {
  for (const entry of INVITE.cases.filter((candidate) => candidate.frame === "INVITE")) {
    it(entry.name, () => {
      const bytes = bytesOf(entry);
      if (entry.expect.refuse) {
        expect(() => parseInvite(bytes)).toThrow(InviteError);
        try { parseInvite(bytes); } catch (error) { expect((error as InviteError).code).toBe(entry.expect.refuse.code); }
        return;
      }
      const invite = parseInvite(bytes);
      expect(invite).toEqual(entry.expect.parse as never);
      // the canonical form: written back, the file is the vector's bytes
      expect(Buffer.from(JSON.stringify(invite)).toString("hex")).toBe(entry.bytes);
    });
  }
});

describe("invite.json: the single-line form through the same reader", () => {
  const lines = INVITE.cases.filter((candidate) => candidate.frame === "INVITE_LINE");
  it("has accepted, decoded-then-refused and refused cases", () => {
    expect(lines.filter((entry) => !entry.expect.refuse).length).toBeGreaterThan(0);
    expect(lines.filter((entry) => entry.expect.refuse?.stage === "verify").length).toBeGreaterThan(0);
    expect(lines.filter((entry) => entry.expect.refuse?.stage === "decode").length).toBeGreaterThan(0);
  });
  for (const entry of lines) {
    it(entry.name, () => {
      const line = Buffer.from(entry.bytes, "hex").toString("utf8");
      if (entry.expect.refuse?.stage === "decode") {
        let code: string | undefined;
        try { inviteLineBytes(line); } catch (error) { if (error instanceof InviteError) code = error.code; else throw error; }
        expect(code).toBe(entry.expect.refuse.code);
        return;
      }
      // a line that decodes gives exactly the file's bytes, which the invite reader then judges alone
      const file = String((entry.expect.parse as Obj)["file_hex"]);
      expect(Buffer.from(inviteLineBytes(line)).toString("hex")).toBe(file);
      if (entry.expect.refuse) {
        expect(() => parseInvite(hexBytes(file))).toThrow(InviteError);
        expect(() => parseInviteLine(line)).toThrow(InviteError);
        return;
      }
      expect(parseInviteLine(line)).toEqual(parseInvite(hexBytes(file)));
      // and the file's line is the canonical one, which decodes back to the same bytes
      expect(inviteLineBytes(inviteLine(hexBytes(file)))).toEqual(hexBytes(file));
      expect(line.trim()).toBe(inviteLine(hexBytes(file)));
    });
  }
});

describe("machine-files.json: fleet.json through the TypeScript reader", () => {
  for (const entry of FILES.cases.filter((candidate) => candidate.frame === "FLEET_FILE")) {
    it(entry.name, () => {
      const bytes = bytesOf(entry);
      if (entry.expect.refuse) {
        let code: string | undefined;
        try { parseFleetFile(bytes); } catch (error) { if (error instanceof FleetFileError) code = error.code; else throw error; }
        expect(code).toBe(entry.expect.refuse.code);
        return;
      }
      expect(parseFleetFile(bytes)).toEqual(entry.expect.parse as never);
    });
  }
});
