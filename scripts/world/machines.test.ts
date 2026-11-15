import { describe, expect, it } from "bun:test";
import { Machine } from "./machines.ts";

const machine = new Machine({ name: "m1", container: "ovw-w-m_m1", ip: "10.243.1.100", engine: "herdr", start: "none", systemd: false, server: "http://127.0.0.1:17611" });

describe("a machine's stand-in agent", () => {
  it("refuses a session name that is not a-z 0-9 - before anything runs in the machine", () => {
    for (const bad of ['x"; touch /tmp/p; "', "$(touch /tmp/p)", "`id`", "a b", ""]) expect(() => machine.standIn(bad)).toThrow();
    expect(() => machine.standIn("ovis-test-stk-a")).not.toThrow();
    expect(() => machine.standIn()).not.toThrow();
  });
});
