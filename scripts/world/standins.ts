/**
 * B5: the stand-in for a real desktop of before as ONE preset that every session names the same way:
 *   --preset od=true-form-desktop[:0.4.22][:six-live][:demo]
 * The default is the TRUE form, as on a long-lived install: the machine's Ovis 0.4.22 launcher and
 * supervisor running a 0.5.1 server its own updater installed, from Settings as a user does it (OVIS_AUTO_UPDATE unset), with
 * a second update folder of an earlier install as a leftover, direct connections on, the live default herdr session plus the five test
 * sessions' folders DEAD with their stale sockets, three agents, herdr-core's default core with four plain shells, a
 * user manager degraded by ydotool. What it does not have of such a desktop (describePreset says it): the direct carrier's
 * listeners (7319 on the machine's home-network and tailnet addresses, its loopback upstream 127.0.0.1:35173,
 * server/relay/direct.ts), which 0.5.1 opens only while its relay is on, and the stand-in's is off. Variants: `0.4.22` (0.4.22 all the way down, which
 * only offers the update) and `six-live` (the five test sessions live too); `demo` adds an earlier demo's unit.
 * One machine (classic herdr 0.9.5, systemd, a user of seven letters with this PC's uid, `ovisusr` unless
 * OVIS_STANDIN_USER names another, hostname true-form-desktop) and its steps (inside/true-form-desktop.sh, in the
 * order such an install comes up: the default session before Ovis, the test sessions after
 * it; the update waited for by the running process). The artifacts come from OVIS_STANDINS (default
 * ~/.local/state/ovis-test-services/standins).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlanError } from "./constants.ts";
import type { MachineSpec } from "./plan.ts";

/** The preset's name, the machine's hostname and the steps' file (inside/true-form-desktop.sh). */
export const PRESET_NAME = "true-form-desktop";

/**
 * herdr's id of the Ovis plugin, read from the repository's own plugin manifest (herdr-plugin.toml): the stand-in's
 * plugin folders and install record carry it, as herdr writes them for the plugin installed from GitHub.
 */
export const PLUGIN_ID: string = (Bun.TOML.parse(readFileSync(join(import.meta.dir, "..", "..", "herdr-plugin.toml"), "utf8")) as { id: string }).id;

/**
 * The stand-in's user (its home is /home/<user>): seven letters, as the user it stands in for, so the true form's paths
 * (its unix sockets under the home among them) keep their lengths. OVIS_STANDIN_USER names another of seven.
 */
export const STANDIN_USER = "ovisusr";
export function standinUser(env: Readonly<Record<string, string | undefined>>): string {
  const user = env["OVIS_STANDIN_USER"] ?? STANDIN_USER;
  if (!/^[a-z][a-z0-9]{6}$/.test(user)) throw new PlanError(`OVIS_STANDIN_USER=${user}: seven lowercase letters or digits, a letter first (the true form's paths keep their lengths)`);
  return user;
}

export interface Preset {
  readonly kind: typeof PRESET_NAME;
  /** the server the machine's Ovis runs: 0.5.1 installed by 0.4.22's updater (true), or 0.4.22 all the way down */
  readonly version: "0.5.1" | "0.4.22";
  /** the five test sessions: their folders with stale sockets (true), or five live servers */
  readonly sessions: "dead" | "live";
  readonly demo: boolean;
}

/** The TRUE form: what `--preset od=true-form-desktop` gives with no option. */
export const TRUE_FORM: Preset = { kind: PRESET_NAME, version: "0.5.1", sessions: "dead", demo: false };

/** `od=true-form-desktop`, `od=true-form-desktop:0.4.22:six-live:demo`: the machine's name and the form it stands in as. */
export function parsePreset(text: string): [string, Preset] {
  const match = new RegExp(`^([a-z][a-z0-9-]{0,14}[a-z0-9])=${PRESET_NAME}((?::[a-z0-9.-]+)*)$`).exec(text);
  if (!match) throw new PlanError(`--preset ${text}: <machine>=${PRESET_NAME}[:0.4.22][:six-live][:demo]`);
  const parts = match[2]!.split(":").filter(Boolean);
  if (new Set(parts).size !== parts.length) throw new PlanError(`--preset ${text}: an option twice`);
  if (parts.includes("0.4.22") && parts.includes("0.5.1")) throw new PlanError(`--preset ${text}: 0.4.22 or 0.5.1, not both`);
  for (const part of parts) if (!["0.5.1", "0.4.22", "six-live", "demo"].includes(part)) throw new PlanError(`--preset ${text}: ${part} is none of 0.5.1 (the default), 0.4.22, six-live, demo`);
  return [match[1]!, { kind: PRESET_NAME, version: parts.includes("0.4.22") ? "0.4.22" : "0.5.1", sessions: parts.includes("six-live") ? "live" : "dead", demo: parts.includes("demo") }];
}

/** Where the preset's artifacts go in the machine (read-only), all copied into the user's home by its steps. */
export const PRESET_MOUNTS = { checkout: "/opt/ovis-0.4.22", mirror: "/opt/od-mirror.git", bunCache: "/opt/od-bun-cache", ptyHost: "/opt/od-pty-host", bin: "/opt/od-bin" } as const;

/** The artifacts a preset needs, each a path under the artifacts' folder. */
const ARTIFACTS = {
  checkout: "ovis-0.4.22/checkout", mirror: "ovis-0.5.1-update/mirror.git", bunCache: "ovis-0.5.1-update/bun-cache",
  ptyHost: "ovis-0.5.1-update/pty-host-0.5.1", bin: "bin",
} as const;

/** The machine and the herdr binary a preset needs, from the artifacts' folder. */
export function presetMachine(name: string, preset: Preset, artifacts: string, user: string = STANDIN_USER): { readonly spec: MachineSpec; readonly herdrBin: string } {
  const wanted = (Object.keys(ARTIFACTS) as (keyof typeof ARTIFACTS)[]).filter((part) => preset.version === "0.5.1" || (part !== "bunCache" && part !== "ptyHost"));
  return {
    spec: { name, engine: "herdr", start: "none", systemd: true, user, hostname: PRESET_NAME, preset,
      mounts: wanted.map((part) => `${join(artifacts, ARTIFACTS[part])}:${PRESET_MOUNTS[part]}`) },
    herdrBin: join(artifacts, "bin", "herdr-0.9.5"),
  };
}

/**
 * The steps, in the order such an install comes up: the default session before Ovis (its startup hook is the one
 * that starts Ovis, bound to the default socket), the update waited for by the running process, the test sessions after.
 */
export function presetSteps(preset: Preset): readonly string[] {
  return [
    "units", "prepare", "herdr-default", "agents", "ovis",
    ...preset.version === "0.5.1" ? ["settings-install", "update-wait", "leftover-update", "direct"] : [], "sessions", ...preset.sessions === "dead" ? ["sessions-dead"] : [],
    "core", ...preset.demo ? ["demo"] : [],
  ];
}

export function describePreset(preset: Preset): string {
  const form = preset.version === "0.5.1" && preset.sessions === "dead" ? "the TRUE form" : `the ${[preset.version === "0.4.22" ? "0.4.22-only" : "", preset.sessions === "live" ? "six-live" : ""].filter(Boolean).join(", ")} variant`;
  const ovis = preset.version === "0.5.1"
    ? "Ovis 0.4.22's launcher and supervisor with a 0.5.1 server its updater installed from Settings (OVIS_AUTO_UPDATE unset), a second update folder left over, direct on; not reproduced: no direct carrier (7319, 127.0.0.1:35173), as the relay is off"
    : "Ovis 0.4.22 all the way down (launcher, supervisor, server), the 0.5.1 update only offered";
  const sessions = preset.sessions === "dead" ? "herdr 0.9.5: the default session live, the five test session folders dead with stale sockets" : "herdr 0.9.5: six live sessions (default and five test sessions)";
  return `${PRESET_NAME}, ${form}: ${ovis}; ${sessions}; three agents; herdr-core 0.1.17's default core with four plain shells; ${preset.demo ? "with" : "without"} the demo's unit`;
}
