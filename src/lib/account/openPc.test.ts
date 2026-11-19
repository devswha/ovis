import { describe, expect, it } from "bun:test";
import { nextOpenStep } from "./openPc.ts";

describe("opening a PC with the account's sign-in", () => {
  it("T34: a held sign-in waits on the PC's own hold, whatever kind it is", () => {
    expect(nextOpenStep({ code: "held", hold: { reason: "join_hold", until: "2026-11-20T04:00:10.000Z" } }, false)).toEqual({ kind: "wait", hold: { reason: "join_hold", until: "2026-11-20T04:00:10.000Z" } });
    expect(nextOpenStep({ code: "held", hold: { reason: "catching_up" } }, true)).toEqual({ kind: "wait", hold: { reason: "catching_up" } });
  });

  it("G5: a key the PC does not list is tried once more, then the QR or digits path is offered", () => {
    expect(nextOpenStep({ code: "not_listed" }, false)).toEqual({ kind: "retry" });
    expect(nextOpenStep({ code: "not_listed" }, true)).toEqual({ kind: "pair" });
  });

  it("T34: a refusal by the PC's final guard offers the QR or digits path at once, with no retry", () => {
    expect(nextOpenStep({ code: "admission" }, false)).toEqual({ kind: "pair" });
  });
});
