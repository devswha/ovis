import { describe, expect, it } from "bun:test";
import { t } from "../lib/i18n.ts";
import { outOfReachReason } from "./relayPcState.tsx";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const MIN = 60_000;
const seen = new Date(NOW - 180 * MIN).toISOString();

describe("outOfReachReason", () => {
  it("says what the last check saw and when, never a guessed cause", () => {
    expect(outOfReachReason({ displayState: "offline", last_seen_at: seen, check: { kind: "offline", reason: "pc", at: NOW - 5 * MIN } }, t, NOW))
      .toBe("The relay answered, but the PC did not. Checked 5 min ago. Last seen 3 h ago.");
    expect(outOfReachReason({ displayState: "unreachable", last_seen_at: seen, check: { kind: "offline", reason: "refused", at: NOW - 5 * MIN } }, t, NOW))
      .toBe("The relay turned this device away. Wait a minute, then check again. Checked 5 min ago.");
    expect(outOfReachReason({ displayState: "unreachable", last_seen_at: null, check: { kind: "offline", reason: "relay", at: NOW - 5 * MIN } }, t, NOW))
      .toBe("This device could not reach the relay. Check this device's network. Checked 5 min ago.");
  });

  it("reads the last finding while a new check runs", () => {
    expect(outOfReachReason({ displayState: "offline", last_seen_at: null, check: { kind: "checking", previous: { kind: "offline", reason: "pc", at: NOW - 5 * MIN } } }, t, NOW))
      .toBe("The relay answered, but the PC did not. Checked 5 min ago.");
  });

  it("says only when the PC was last seen before any check of this device", () => {
    expect(outOfReachReason({ displayState: "offline", last_seen_at: seen }, t, NOW)).toBe("Last seen 3 h ago.");
    expect(outOfReachReason({ displayState: "offline", last_seen_at: null }, t, NOW)).toBeNull();
  });
});
