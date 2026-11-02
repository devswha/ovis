import { describe, expect, it } from "bun:test";

import { advanceOrbMotion, createOrbMotionDriver, ORB_MAX_SCALE, orbModeFor, orbVolumeLevel, type OrbMotionMode } from "./orbMotion.ts";

/** Runs the driver for `seconds` at `fps` with fixed levels and returns its last frame. */
function settle(mode: OrbMotionMode, input: number, output: number, seconds = 3, fps = 60) {
  const driver = createOrbMotionDriver();
  let frame = advanceOrbMotion(driver, input, output, mode, 0);
  for (let step = 0; step < seconds * fps; step += 1) frame = advanceOrbMotion(driver, input, output, mode, 1 / fps);
  return frame;
}

describe("the orb's loudness", () => {
  it("maps decibels, not amplitude: room noise is nothing and close-mic speech is full", () => {
    expect(orbVolumeLevel(0)).toBe(0);
    expect(orbVolumeLevel(10 ** (-46 / 20))).toBeCloseTo(0, 5);
    expect(orbVolumeLevel(10 ** (-14 / 20))).toBeCloseTo(1, 5);
    expect(orbVolumeLevel(1)).toBe(1);
    expect(orbVolumeLevel(0.05)).toBeGreaterThan(orbVolumeLevel(0.01));
    expect(orbVolumeLevel(Number.NaN)).toBe(0);
    expect(orbVolumeLevel(-1, 0.1)).toBe(orbVolumeLevel(0.1));
  });
});

describe("the orb's motion", () => {
  it("swells with the reply but never past its cap", () => {
    expect(settle("speaking", 0, 1).scale).toBeCloseTo(ORB_MAX_SCALE, 2);
    expect(settle("speaking", 0, 0).scale).toBeCloseTo(1, 2);
    for (const level of [0, 0.3, 1, 5]) expect(settle("speaking", 0, level, 1).scale).toBeLessThanOrEqual(ORB_MAX_SCALE);
  });

  it("draws in while the user speaks, and rests smaller and dimmer when muted", () => {
    expect(settle("listening", 1, 0).scale).toBeLessThan(0.9);
    const muted = settle("muted", 1, 1);
    expect(muted.scale).toBeCloseTo(0.97, 1);
    expect(muted.opacity).toBeCloseTo(0.78, 1);
  });

  it("rests dim and slow while parked, whatever the levels say", () => {
    const parked = settle("parked", 1, 1);
    const quiet = settle("parked", 0, 0);
    expect(parked.scale).toBeCloseTo(quiet.scale, 3);
    expect(parked.opacity).toBeCloseTo(quiet.opacity, 3);
    expect(parked.opacity).toBeLessThan(settle("muted", 0, 0).opacity);
    expect(parked.time).toBeLessThan(settle("listening", 0, 0).time);
  });

  it("flows faster while speaking than when muted", () => {
    expect(settle("speaking", 0, 1).time).toBeGreaterThan(settle("muted", 0, 0).time * 2);
  });

  it("reaches the same rest at any frame rate", () => {
    const slow = settle("speaking", 0, 0.6, 3, 30);
    const fast = settle("speaking", 0, 0.6, 3, 120);
    expect(slow.scale).toBeCloseTo(fast.scale, 2);
    expect(slow.opacity).toBeCloseTo(fast.opacity, 2);
  });

  it("does not let a stalled frame jump the orb", () => {
    const driver = createOrbMotionDriver();
    const frame = advanceOrbMotion(driver, 0, 1, "speaking", 60);
    expect(frame.scale).toBeLessThanOrEqual(ORB_MAX_SCALE);
    expect(Number.isFinite(frame.time)).toBe(true);
  });
});

describe("what the orb does for each phase of the call", () => {
  it("follows Pi's phases", () => {
    expect(orbModeFor("connecting")).toBe("connecting");
    expect(orbModeFor("standby")).toBe("connecting");
    expect(orbModeFor("listening")).toBe("listening");
    expect(orbModeFor("working")).toBe("thinking");
    expect(orbModeFor("speaking")).toBe("speaking");
    expect(orbModeFor("muted")).toBe("muted");
    expect(orbModeFor("parked")).toBe("parked");
    expect(orbModeFor("error")).toBe("error");
    expect(orbModeFor("ended")).toBe("ended");
  });
});
