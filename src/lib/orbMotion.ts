/**
 * How the voice call's orb moves: its swell, its rest and the speed of its flow, from the
 * microphone's and the reply's levels and the phase of the call.
 *
 * Adapted from the agents app's agent-orb (packages/agent-orb/src/motion.ts, © Ricardo Felix);
 * see THIRD_PARTY_NOTICES.md. The constants and the closed-form spring are the same, so the orb
 * moves as it does there; the modes are the ones Pi's call phases need.
 */
import type { PiVoicePhase } from "../../shared/pi-voice.ts";

export const ORB_MAX_SCALE = 1.15;

export type OrbMotionMode = "connecting" | "listening" | "thinking" | "speaking" | "muted" | "parked" | "error" | "ended";

export type OrbMotionDriver = {
  /** Seconds since the driver started; paces idle breathing and pulses. */
  clock: number;
  /** Rate at which the shader's liquid currently flows (1 = at rest). */
  flowRate: number;
  inputLevel: number;
  opacity: number;
  outputLevel: number;
  scale: number;
  /** Shader time. It advances faster while someone speaks. */
  time: number;
  velocity: number;
};

export type OrbMotionFrame = { opacity: number; scale: number; time: number };

// Loudness is mapped in decibels: below the floor is room noise and breath, the ceiling is
// ordinary close-mic speech. Linear gain made quiet rooms shimmer while normal speech barely
// reached full size.
const LEVEL_FLOOR_DB = -46;
const LEVEL_CEILING_DB = -14;

// A fast attack keeps syllables legible; a slower release stops the orb chattering between words.
const LEVEL_ATTACK_SECONDS = 0.05;
const LEVEL_RELEASE_SECONDS = 0.22;

// A slightly underdamped spring: the orb settles with a small overshoot instead of easing mechanically.
const SPRING_FREQUENCY = 17; // rad/s
const SPRING_DAMPING = 0.74;

const BREATH_PERIOD_SECONDS = 4.8;
const BREATH_DEPTH = 0.012;
const THINKING_PERIOD_SECONDS = 1.6;
const THINKING_DEPTH = 0.02;
const USER_CONTRACTION = 0.16;
// The orb follows the microphone while listening; this ramp keeps quiet room sound from moving it.
const INPUT_ACTIVITY_FLOOR = 0.1;
const INPUT_ACTIVITY_FULL = 0.4;
const MAX_ELAPSED_SECONDS = 0.25;

export function createOrbMotionDriver(): OrbMotionDriver {
  return { clock: 0, flowRate: 1, inputLevel: 0, opacity: 0.9, outputLevel: 0, scale: 1, time: 0, velocity: 0 };
}

/** Maps linear amplitudes (RMS or audio levels, 0–1) to the orb's level. */
export function orbVolumeLevel(...volumes: number[]): number {
  const peak = Math.max(0, ...volumes.map((volume) => (Number.isFinite(volume) ? volume : 0)));
  if (peak <= 0) return 0;
  const decibels = 20 * Math.log10(peak);
  const position = clampLevel((decibels - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB));
  return position * position * (3 - 2 * position);
}

/** The motion for a phase of Pi's call; `ended` is the view after the call is over. */
export function orbModeFor(phase: PiVoicePhase | "ended"): OrbMotionMode {
  switch (phase) {
    case "listening": return "listening";
    case "working": return "thinking";
    case "speaking": return "speaking";
    case "muted": return "muted";
    case "parked": return "parked";
    case "error": return "error";
    case "ended": return "ended";
    default: return "connecting";
  }
}

export function advanceOrbMotion(driver: OrbMotionDriver, inputLevel: number, outputLevel: number, mode: OrbMotionMode, deltaSeconds: number): OrbMotionFrame {
  const elapsed = Number.isFinite(deltaSeconds) ? Math.min(MAX_ELAPSED_SECONDS, Math.max(0, deltaSeconds)) : 0;
  const status = mode === "error" || mode === "ended" || mode === "parked";
  const audible = status ? 0 : mode === "thinking" ? 0.25 : mode === "muted" ? 0.1 : 1;

  driver.clock += elapsed;
  driver.inputLevel = follow(driver.inputLevel, clampLevel(inputLevel) * audible, elapsed);
  driver.outputLevel = follow(driver.outputLevel, clampLevel(outputLevel) * audible, elapsed);
  const input = driver.inputLevel;
  const output = driver.outputLevel;
  const inputActivity = clampLevel((input - INPUT_ACTIVITY_FLOOR) / (INPUT_ACTIVITY_FULL - INPUT_ACTIVITY_FLOOR));

  const breath = Math.sin((2 * Math.PI * driver.clock) / BREATH_PERIOD_SECONDS);
  const pulse = Math.sin((2 * Math.PI * driver.clock) / THINKING_PERIOD_SECONDS);
  let targetScale: number;
  let targetOpacity: number;
  let targetFlow: number;
  switch (mode) {
    case "speaking":
      targetScale = 1 + output * (ORB_MAX_SCALE - 1);
      targetOpacity = 0.9 + output * 0.1;
      targetFlow = 1 + output * 1.5;
      break;
    case "listening":
      targetScale = 1 + breath * BREATH_DEPTH * (1 - inputActivity) - input * USER_CONTRACTION * inputActivity;
      targetOpacity = 0.9 + input * 0.1 * inputActivity;
      targetFlow = 1 + input * 0.9 * inputActivity;
      break;
    case "thinking":
      targetScale = 1 + pulse * THINKING_DEPTH;
      targetOpacity = 0.92;
      targetFlow = 1.6;
      break;
    case "muted":
      targetScale = 0.97;
      targetOpacity = 0.78;
      targetFlow = 0.6;
      break;
    case "parked":
      // asleep while the task runs: a slow breath, dimmer than anything live
      targetScale = 1 + breath * BREATH_DEPTH;
      targetOpacity = 0.5 + breath * 0.04;
      targetFlow = 0.45;
      break;
    case "connecting":
      targetScale = 1 + breath * BREATH_DEPTH;
      targetOpacity = 0.82 + breath * 0.04;
      targetFlow = 0.8;
      break;
    default:
      targetScale = 0.97;
      targetOpacity = 0.64;
      targetFlow = 0.35;
  }

  springToward(driver, targetScale, elapsed);
  driver.opacity = approach(driver.opacity, targetOpacity, elapsed, 0.2);
  driver.flowRate = approach(driver.flowRate, targetFlow, elapsed, 0.35);
  driver.time += driver.flowRate * elapsed;

  return { opacity: driver.opacity, scale: Math.min(ORB_MAX_SCALE, driver.scale), time: driver.time };
}

function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

function approach(current: number, target: number, elapsed: number, timeConstant: number): number {
  return target + (current - target) * Math.exp(-elapsed / timeConstant);
}

function follow(current: number, target: number, elapsed: number): number {
  return approach(current, target, elapsed, target > current ? LEVEL_ATTACK_SECONDS : LEVEL_RELEASE_SECONDS);
}

/** Advances the damped spring with its closed-form solution, so the motion is the same at any frame rate. */
function springToward(driver: OrbMotionDriver, target: number, elapsed: number): void {
  if (elapsed <= 0) return;
  const decay = SPRING_DAMPING * SPRING_FREQUENCY;
  const damped = SPRING_FREQUENCY * Math.sqrt(1 - SPRING_DAMPING * SPRING_DAMPING);
  const offset = driver.scale - target;
  const velocity = driver.velocity;
  const envelope = Math.exp(-decay * elapsed);
  const cosine = Math.cos(damped * elapsed);
  const sine = Math.sin(damped * elapsed);
  const b = (velocity + decay * offset) / damped;
  driver.scale = target + envelope * (offset * cosine + b * sine);
  driver.velocity = envelope * (velocity * cosine - ((decay * velocity + SPRING_FREQUENCY * SPRING_FREQUENCY * offset) / damped) * sine);
}
