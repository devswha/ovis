import { describe, expect, it } from "bun:test";
import { FLEET_CAUSE_FALLBACK, FLEET_CAUSE_KIND, FLEET_CAUSE_SENTENCE, FLEET_CAUSES, isFleetCause, parseFleetCause } from "./fleet-cause.ts";

describe("the closed set of causes", () => {
  it("gives every cause a kind and a sentence of its own, and the fallback is a cause", () => {
    for (const cause of FLEET_CAUSES) expect(["stops", "warns"]).toContain(FLEET_CAUSE_KIND[cause]);
    // the sentence is the i18n key: two causes with one sentence would share a translation
    const sentences = FLEET_CAUSES.map((cause) => FLEET_CAUSE_SENTENCE[cause]);
    expect(sentences.every((sentence) => sentence.length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(FLEET_CAUSES.length);
    expect(new Set(FLEET_CAUSES).size).toBe(FLEET_CAUSES.length);
    expect(isFleetCause(FLEET_CAUSE_FALLBACK)).toBe(true);
  });

  it("reads a known value as itself and anything else (an older or newer peer) as the fallback", () => {
    for (const cause of FLEET_CAUSES) expect(parseFleetCause(cause)).toBe(cause);
    for (const value of ["a_cause_from_the_future", "", "OFFLINE", "offline ", null, undefined, 7, {}, ["offline"], "__proto__", "toString", "constructor", "hasOwnProperty"]) {
      expect(isFleetCause(value)).toBe(false);
      expect(parseFleetCause(value)).toBe(FLEET_CAUSE_FALLBACK);
    }
  });
});
