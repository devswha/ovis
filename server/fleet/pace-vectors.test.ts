/**
 * PACE and `relay_pace` (docs/fleet-link.md sections 1 and 3, todo 37) against server/fleet/vectors/pace.json: the
 * controller's encoder writes every accepted case's bytes exactly, its codec refuses a PACE a machine sends, the field
 * checks refuse the out-of-range cases, and the numbers of `derivations` (the two profiles, the default slot and the
 * next dial instants) are what server/fleet/relay-pace.ts computes. The machine's side of the same file is the Rust
 * crate's (crates/fleet-link/src/session_tests.rs).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFrame, encodeExtensionFrame, isExtensionFrame, MuxProtocolError } from "../../shared/relay-mux.ts";
import { bounded, relayFixture } from "../relay/test-helpers.ts";
import { fleetMuxExtension, paceFrame, pipeMuxExtension, readRelayPace } from "./mux-ext.ts";
import { machineConnection, machineKey, memoryDirectory, recordOf } from "./test-helpers.ts";
import type { RelayPace } from "./mux-ext.ts";
import { defaultPaceSlot, nextPaceInstant, relayPace } from "./relay-pace.ts";

type Obj = Record<string, unknown>;
interface Case {
  name: string; frame: string; type: number; stream_id: number; direction: "machine_to_controller" | "controller_to_machine";
  context: Obj & { state: "before_auth" | "after_auth" }; bytes: string;
  expect: { parse?: Obj; refuse?: { stage: string; kind: string; code: string } };
}
interface Derivations {
  profiles: { budget: number; per_minute: number; burst: number; spacing_ms: number; machine_per_minute: number; machine_spacing_ms: number }[];
  default_slot: { machine_id: string; slot: number };
  next_instant: { slot: number; span: number; spacing_ms: number; loss_controller_ms: number; instant_controller_ms: number }[];
}
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "vectors", "pace.json"), "utf8")) as { derivations: Derivations; cases: Case[] };
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));

describe("pace.json", () => {
  it("covers every case below", () => {
    expect(vectors.cases.map((entry) => entry.name).sort()).toEqual([
      "pace/before-auth", "pace/cycle-under-a-minute", "pace/fleet-flags", "pace/from-machine", "pace/hosted", "pace/per-minute-zero",
      "pace/rtt-above-pong-deadline", "pace/slot-not-below-span",
    ]);
  });

  for (const entry of vectors.cases.filter((candidate) => candidate.direction === "controller_to_machine" && candidate.expect.parse && !candidate.expect.refuse)) {
    it(`${entry.name}: the controller writes these bytes exactly`, () => {
      expect(hex(encodeExtensionFrame(paceFrame(entry.expect.parse as unknown as RelayPace), pipeMuxExtension))).toBe(entry.bytes);
      const read = decodeFrame(fromHex(entry.bytes), false, pipeMuxExtension);
      expect(isExtensionFrame(read) && read.payload).toEqual(entry.expect.parse!);
    });
  }

  it("pace/before-auth: the bytes are an accepted PACE; only the machine's state refuses them (crates/fleet-link)", () => {
    const entry = vectors.cases.find((candidate) => candidate.name === "pace/before-auth")!;
    expect(hex(encodeExtensionFrame(paceFrame(entry.expect.parse as unknown as RelayPace), pipeMuxExtension))).toBe(entry.bytes);
  });

  it("pace/from-machine: parsed, then the controller's session ends protocol_error; before HELLO the codec refuses it", async () => {
    const entry = vectors.cases.find((candidate) => candidate.name === "pace/from-machine")!;
    const read = decodeFrame(fromHex(entry.bytes), true, pipeMuxExtension);
    expect(isExtensionFrame(read) && read.payload).toEqual(entry.expect.parse!);
    let error: unknown;
    try { decodeFrame(fromHex(entry.bytes), true, fleetMuxExtension); } catch (caught) { error = caught; }
    expect((error as MuxProtocolError).code).toBe("protocol_error");
    const key = await machineKey();
    const app = relayFixture();
    try {
      const machine = await machineConnection(app, memoryDirectory([recordOf(key)]));
      await machine.hello();
      await machine.signIn(key);
      machine.sendBytes(fromHex(entry.bytes));
      expect((await bounded(machine.error)).code).toBe("protocol_error");
    } finally { app.close(); }
  });

  for (const entry of vectors.cases.filter((candidate) => candidate.expect.refuse?.stage === "decode")) {
    it(`${entry.name}: refused protocol_error by the field checks, and never written`, () => {
      const payload = JSON.parse(Buffer.from(fromHex(entry.bytes).subarray(8)).toString("utf8")) as Obj;
      let error: unknown;
      try { readRelayPace(payload); } catch (caught) { error = caught; }
      expect((error as MuxProtocolError).code).toBe("protocol_error");
      expect(() => encodeExtensionFrame(paceFrame(payload as unknown as RelayPace), pipeMuxExtension)).toThrow();
      expect(() => decodeFrame(fromHex(entry.bytes), false, pipeMuxExtension)).toThrow(MuxProtocolError);
    });
  }

  it("derivations: the profiles are relay-pace.ts's for each budget", () => {
    for (const profile of vectors.derivations.profiles) expect(relayPace(profile.budget)).toEqual(profile);
  });

  it("derivations: the default slot is the machine id's first four hex digits mod 100", () => {
    expect(defaultPaceSlot(vectors.derivations.default_slot.machine_id)).toBe(vectors.derivations.default_slot.slot);
  });

  it("derivations: the next instant after a loss", () => {
    for (const row of vectors.derivations.next_instant) {
      expect(nextPaceInstant({ slot: row.slot, span: row.span, spacing_ms: row.spacing_ms }, row.loss_controller_ms)).toBe(row.instant_controller_ms);
    }
  });
});
