/**
 * A fleet machine's session on a controller (docs/fleet-link.md sections 1 and 3), end to end: a machine client on
 * the protected channel signs in with its machine key against a RelaySession of a server started with `port: 0`. The
 * refusals are generated from the document's own tables, so a row added there without a way to send its frame fails
 * here; each one must end the session with its code and leave devices.json byte-identical.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FrameType } from "../../shared/relay-mux.ts";
import type { SessionError } from "../../shared/relay-mux.ts";
import { machineConnection, machineKey, memoryDirectory, recordOf, SERVER_ID } from "../fleet/test-helpers.ts";
import type { MachineKey } from "../fleet/test-helpers.ts";
import type { FleetDirectory, MachineState } from "../fleet/mux-ext.ts";
import { Fleet } from "../fleet/sessions.ts";
import { FleetStore } from "../fleet/store.ts";
import type { RelaySession } from "./session.ts";
import { bounded, relayConnection, relayDevice, relayFixture } from "./test-helpers.ts";

const ROOT = join(import.meta.dir, "..", "..");
const doc = readFileSync(join(ROOT, "docs", "fleet-link.md"), "utf8");
/** The rows of a `<!-- contract:<marker> -->` table, cells without their code ticks. */
function table(marker: string): string[][] {
  const lines = doc.split("\n");
  const at = lines.indexOf(`<!-- contract:${marker} -->`);
  if (at < 0) throw new Error(`no table ${marker}`);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("|")) { if (rows.length) break; continue; }
    rows.push(line.slice(1, -1).split("|").map((cell) => cell.trim().replace(/`/g, "")));
  }
  return rows.slice(2);
}
const answer = (text: string): SessionError => {
  const match = /^SESSION_ERROR ([a-z_]+)$/.exec(text);
  if (!match) throw new Error(`not a session error: ${text}`);
  return match[1] as SessionError;
};

interface Vector { name: string; frame: string; direction: string; context: { state?: string }; bytes: string }
const vectors: Vector[] = readdirSync(join(ROOT, "server", "fleet", "vectors")).filter((file) => file.endsWith(".json"))
  .flatMap((file) => (JSON.parse(readFileSync(join(ROOT, "server", "fleet", "vectors", file), "utf8")) as { cases: Vector[] }).cases);
/** Bytes of `frame` as a machine sends it, from the vectors: one in `state` when there is one. */
function bytesOf(frame: string, state: string): Uint8Array | undefined {
  const sent = vectors.filter((entry) => entry.frame === frame && entry.direction === "machine_to_controller");
  const chosen = sent.find((entry) => entry.context.state === state) ?? sent[0];
  return chosen && Uint8Array.from(Buffer.from(chosen.bytes, "hex"));
}

const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

/** A controller with one paired phone (so devices.json exists) and one machine in its fleet. */
async function controller(state: MachineState = "active", directory?: (key: MachineKey, stateDir: string) => FleetDirectory) {
  const fixture = relayFixture();
  fixtures.push(fixture);
  await relayDevice(fixture);
  const key = await machineKey();
  const fleet = directory?.(key, fixture.stateDir) ?? memoryDirectory([recordOf(key, state)]);
  const services = fixture.app.context.services;
  const devicesFile = join(fixture.stateDir, "devices.json");
  if (!existsSync(devicesFile)) throw new Error("no devices.json");
  const digest = () => createHash("sha256").update(readFileSync(devicesFile)).digest("hex");
  const ask = spyOn(services.relay.approvals, "ask");
  const before = { digest: digest(), devices: services.devices.list(null) };
  return {
    fixture, key, fleet, ask,
    connect: () => machineConnection(fixture, fleet, fleet instanceof Fleet ? { machineSessions: fleet } : {}),
    /** Nothing a device holds changed: devices.json byte for byte, the device list, and no approval prompt. */
    unchanged() {
      expect(digest()).toBe(before.digest);
      expect(services.devices.list(null)).toEqual(before.devices);
      expect(ask).not.toHaveBeenCalled();
      expect(services.relay.approvals.list()).toEqual([]);
    },
  };
}

describe("a machine signs in", () => {
  it("gets AUTH_OK with role machine and becomes no device", async () => {
    const c = await controller();
    const machine = await c.connect();
    const authenticate = spyOn(machine.session.mux, "authenticate");
    await machine.hello();
    const ok = await machine.signIn(c.key);
    expect(ok).toEqual({ session_id: expect.stringMatching(/^[0-9a-f]{32}$/), machine_id: c.key.id, role: "machine" });
    expect(authenticate).not.toHaveBeenCalled();
    expect(machine.frames).toContain(FrameType.AUTH_OK);
    // the machine's own engine opens no device stream either
    expect(() => machine.mux.openHttp({ target: "/api/health", method: "GET", headers: [], body: "none" })).toThrow("Cannot open a stream");
    c.unchanged();
  });

  it("then sending HTTP_OPEN, or PAIR_REQUEST with the pairing window open, ends the session", async () => {
    for (const frame of ["HTTP_OPEN", "PAIR_REQUEST"]) {
      const c = await controller();
      c.fixture.app.context.services.relay.approvals.openWindow();
      const machine = await c.connect();
      await machine.hello();
      await machine.signIn(c.key);
      machine.sendBytes(bytesOf(frame, "after_auth")!);
      expect((await bounded(machine.error)).code).toBe("protocol_error");
      await bounded(machine.closed);
      c.unchanged();
    }
  });

  it("cannot pair before signing in, even with a code that holds: nothing is spent and no device is made", async () => {
    const c = await controller();
    const code = c.fixture.app.context.services.devices.startPairing().code;
    const machine = await c.connect();
    await machine.hello();
    const pair = { code, label: "machine", public_key: c.key.spki };
    const bytes = new Uint8Array([1, FrameType.PAIR, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(JSON.stringify(pair))]);
    machine.sendBytes(bytes);
    expect(await bounded(machine.error)).toEqual({ code: "auth_failed", message: "wrong_scheme" });
    c.unchanged();
    // the code was not looked at: it still pairs a phone
    expect(c.fixture.app.context.services.devices.pairRelay(code, "Phone", (await machineKey()).spki)).not.toBeNull();
  });
});

describe("docs/fleet-link.md section 3: what a machine session may never send", () => {
  const rows = table("never-from-machine");
  it("has rows", () => expect(rows.length).toBeGreaterThan(10));
  for (const [frame = "", when = "", answerText = ""] of rows) {
    for (const state of when === "any" ? ["before_auth", "after_auth"] : [when]) {
      it(`${frame} ${state}: SESSION_ERROR ${answer(answerText)}`, async () => {
        const bytes = bytesOf(frame, state);
        if (!bytes) throw new Error(`no vector sends ${frame} from a machine`);
        const c = await controller();
        const machine = await c.connect();
        await machine.hello();
        if (state === "after_auth") await machine.signIn(c.key);
        machine.sendBytes(bytes);
        const error = await bounded(machine.error);
        expect(error.code).toBe(answer(answerText));
        if (error.code === "auth_failed") expect(error.message).toBe("wrong_scheme");
        await bounded(machine.closed);
        c.unchanged();
      });
    }
  }
});

describe("docs/fleet-link.md section 1: the causes a sign-in ends with", () => {
  /** The causes of enrolment (todo 30) and of the witness (todo 31) are refused by code those todos add. */
  const later = new Set(["auth_failed/expired", "auth_failed/rate_limited", "auth_failed/restored"]);
  type Machine = Awaited<ReturnType<typeof machineConnection>>;
  const scenarios: Record<string, (c: Awaited<ReturnType<typeof controller>>, machine: Machine) => Promise<void>> = {
    "auth_failed/signature": async (c, machine) => {
      const other = await machineKey();
      await machine.hello();
      await machine.sendAuth(other, { machineId: c.key.id });
    },
    "auth_failed/unknown": async (_c, machine) => { await machine.hello(); await machine.sendAuth(await machineKey()); },
    "auth_failed/wrong_scheme": async (c, machine) => {
      await machine.hello();
      machine.sendBytes(deviceAuth(c.key.id));
    },
    "auth_revoked/revoked": async (c, machine) => { await machine.hello(); await machine.sendAuth(c.key); },
    "auth_revoked/quarantined": async (c, machine) => { await machine.hello(); await machine.sendAuth(c.key); },
    "resource_exhausted/controller_limit": async (c, machine) => { await machine.hello(); await machine.sendAuth(c.key); },
    "auth_failed/fleet_token_required": async (c, machine) => { await machine.hello(); await machine.sendAuth(c.key); },
  };
  /** A fleet of a controller with no OVIS_TOKEN (server/fleet/gate.ts): held, whatever its store holds. */
  const held = (key: MachineKey, stateDir: string): FleetDirectory => {
    const store = new FleetStore({ stateDir });
    store.add({ machine_id: key.id, public_key: key.spki });
    store.setState(key.id, "active");
    return new Fleet({ stateDir, store, tokenConfigured: false });
  };
  /** A fleet with OVIS_FLEET_MAX 1 whose one place another machine's session holds. */
  const full = (key: MachineKey, stateDir: string): FleetDirectory => {
    const store = new FleetStore({ stateDir });
    store.add({ machine_id: key.id, public_key: key.spki });
    store.setState(key.id, "active");
    const fleet = new Fleet({ stateDir, tokenConfigured: true, store, max: 1 });
    fleet.admit("f".repeat(32), {} as RelaySession);
    return fleet;
  };
  const states: Record<string, MachineState> = { "auth_revoked/revoked": "revoked", "auth_revoked/quarantined": "quarantined" };
  for (const [code = "", message = ""] of table("causes")) {
    const cause = `${code}/${message}`;
    if (later.has(cause)) continue;
    it(`${code} ${message}`, async () => {
      const scenario = scenarios[cause];
      if (!scenario) throw new Error(`no scenario for ${cause}`);
      const c = await controller(states[cause] ?? "active", cause === "resource_exhausted/controller_limit" ? full : cause === "auth_failed/fleet_token_required" ? held : undefined);
      const machine = await c.connect();
      await scenario(c, machine);
      expect(await bounded(machine.error)).toEqual({ code: code as SessionError, message });
      expect(machine.frames).not.toContain(FrameType.AUTH_OK);
      c.unchanged();
    });
  }
  it("leaves only the enrolment and witness causes to later todos", () => {
    const causes = table("causes").map(([code, message]) => `${code}/${message}`);
    expect(causes.filter((cause) => !later.has(cause)).sort()).toEqual(Object.keys(scenarios).sort());
  });
});

/** AUTH `device-key` for an id that is not even this PC's device: refused before it is looked up. */
function deviceAuth(seed: string): Uint8Array {
  const payload = { scheme: "device-key", device_id: seed.slice(0, 16), signature: Buffer.alloc(64, 1).toString("base64url") };
  return new Uint8Array([1, FrameType.AUTH, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(JSON.stringify(payload))]);
}

describe("a signature is bound to its connection, its controller and its nonce", () => {
  const OTHER_SERVER_ID: string = "fedcba9876543210fedcba9876543210";
  if (OTHER_SERVER_ID === SERVER_ID) throw new Error("the other controller must differ");
  it("takes the signature made for this connection", async () => {
    const c = await controller();
    const machine = await c.connect();
    await machine.hello();
    expect((await machine.signIn(c.key)).machine_id).toBe(c.key.id);
  });
  it("refuses one made for another connection: its binding and its nonce", async () => {
    const c = await controller();
    const first = await c.connect();
    const firstNonce = await first.hello();
    const second = await c.connect();
    await second.hello();
    await second.sendAuth(c.key, { nonce: firstNonce, binding: first.binding });
    expect(await bounded(second.error)).toEqual({ code: "auth_failed", message: "signature" });
    c.unchanged();
  });
  it("refuses one made with another connection's binding, even over this connection's nonce", async () => {
    const c = await controller();
    const first = await c.connect();
    await first.hello();
    const second = await c.connect();
    await second.hello();
    expect(first.binding).not.toEqual(second.binding);
    await second.sendAuth(c.key, { binding: first.binding });
    expect(await bounded(second.error)).toEqual({ code: "auth_failed", message: "signature" });
  });
  it("refuses one made for another controller's server_id", async () => {
    const c = await controller();
    const machine = await c.connect();
    await machine.hello();
    await machine.sendAuth(c.key, { serverId: OTHER_SERVER_ID });
    expect(await bounded(machine.error)).toEqual({ code: "auth_failed", message: "signature" });
  });
  it("refuses one made over an older nonce of this controller, on this connection's binding", async () => {
    const c = await controller();
    const earlier = await c.connect();
    const older = await earlier.hello();
    earlier.stop();
    const machine = await c.connect();
    const nonce = await machine.hello();
    expect(Buffer.from(nonce).equals(Buffer.from(older))).toBe(false);
    await machine.sendAuth(c.key, { nonce: older });
    expect(await bounded(machine.error)).toEqual({ code: "auth_failed", message: "signature" });
  });
});

describe("revocation", () => {
  for (const [state, cause] of [["revoked", "revoked"], ["quarantined", "quarantined"], [null, "revoked"]] as const) {
    it(`ends a signed-in machine's session when its record becomes ${state ?? "removed"}`, async () => {
      const directory = { current: undefined as ReturnType<typeof memoryDirectory> | undefined };
      const c = await controller("active", (key) => (directory.current = memoryDirectory([recordOf(key)])));
      const machine = await c.connect();
      await machine.hello();
      await machine.signIn(c.key);
      directory.current!.set(c.key.id, state);
      expect(await bounded(machine.error)).toEqual({ code: "auth_revoked", message: cause });
      c.unchanged();
    });
  }
  it("refuses a machine revoked while its signature was being checked, before AUTH_OK", async () => {
    let reads = 0;
    const c = await controller("active", (key) => ({
      machines: () => [recordOf(key, ++reads > 1 ? "revoked" : "active")],
      onChange: () => () => {},
    }));
    const machine = await c.connect();
    await machine.hello();
    await machine.sendAuth(c.key);
    expect(await bounded(machine.error)).toEqual({ code: "auth_revoked", message: "revoked" });
    expect(machine.frames).not.toContain(FrameType.AUTH_OK);
  });
});

describe("a device session cannot reach the machine path", () => {
  it("on a fleet controller: a device still signs in, and no type of 0x40-0x4f is taken from it", async () => {
    for (let type = 0x40; type <= 0x4f; type++) {
      const c = await controller();
      const device = await relayDevice(c.fixture);
      const link = await relayConnection(c.fixture, { fleet: c.fleet });
      expect((await link.auth(device)).device_id).toBe(device.id);
      link.transformClientFrame = (bytes) => bytes[1] === FrameType.PING ? new Uint8Array([1, type, 0, 0, 0, 0, 0, 0, 0x7b, 0x7d]) : bytes;
      link.mux.enqueueControl({ type: FrameType.PING, flags: 0, stream_id: 0, payload: 0n });
      expect(await bounded(link.serverError)).toBe("protocol_error");
    }
  });
  it("on a fleet controller: AUTH machine-key after a device HELLO is auth_failed wrong_scheme", async () => {
    const c = await controller();
    const machine = await c.connect();
    await machine.hello([], []);
    await machine.sendAuth(c.key);
    expect(await bounded(machine.error)).toEqual({ code: "auth_failed", message: "wrong_scheme" });
    c.unchanged();
  });
  it("without a fleet: a pipe-stream HELLO is unsupported_extension and a machine AUTH does not decode", async () => {
    const fixture = relayFixture();
    fixtures.push(fixture);
    const hello = await machineConnection(fixture, null);
    hello.sendBytes(new Uint8Array([1, FrameType.HELLO, 0, 0, 0, 0, 0, 0,
      ...new TextEncoder().encode(JSON.stringify({ protocol: "ovis-mux", versions: [1], features: ["pipe-stream"], required_features: ["pipe-stream"] }))]));
    expect((await bounded(hello.error)).code).toBe("unsupported_extension");
    const auth = await machineConnection(fixture, null);
    await auth.hello([], []);
    auth.sendBytes(bytesOf("AUTH", "before_auth")!);
    expect((await bounded(auth.error)).code).toBe("protocol_error");
  });
});
