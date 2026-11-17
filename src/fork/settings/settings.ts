import { isPiVoice, type PiVoice } from "../../../shared/pi-voice.ts";
import { SPEECH_DEFAULT_VOICE, SPEECH_VOICES, type SpeechVoice } from "../../../shared/speech.ts";

import { DEFAULT_KEY_BAR_ITEMS, type KeyBarItem } from "../../lib/keyBar.ts";

const legacyKeyBarItems: KeyBarItem[] = DEFAULT_KEY_BAR_ITEMS.flatMap((item): KeyBarItem[] =>
  item.type === "modifier" && item.modifier === "shift" ? [item, { type: "modifier", modifier: "super" }] : [item]);

/** Fork choices. New devices keep upstream's behavior. */
export interface ForkSettings {
  followOmarchy: boolean;
  openLiveWork: boolean;
  speechVoice: SpeechVoice;
  liveVoice: PiVoice | "pi";
  squareCorners: boolean;
  moreViewToggle: boolean;
  agentFriends: boolean;
  piModelPicker: boolean;
  chatMotion: boolean;
  piLiveVoice: boolean;
  computerView: boolean;
  pullRequests: boolean;
  inboxFooter: boolean;
  readAloud: boolean;
  muteSubAgents: boolean;
  notes: boolean;
}

export const FORK_DEFAULTS: ForkSettings = {
  followOmarchy: false, openLiveWork: true,
  speechVoice: SPEECH_DEFAULT_VOICE, liveVoice: "pi",
  squareCorners: false, moreViewToggle: false, agentFriends: false,
  piModelPicker: false, chatMotion: false, piLiveVoice: false,
  computerView: false, pullRequests: false, inboxFooter: false, readAloud: false,
  muteSubAgents: true, notes: false,
};

export const FORK_SCOPE = {
  ...(Object.fromEntries(Object.keys(FORK_DEFAULTS).map((key) => [key, "device"])) as Record<keyof ForkSettings, "device">),
  // the server's push alerts read it too (shared/fork/alerts.ts)
  muteSubAgents: "shared",
} as const;

export function sanitizeForkSettings(record: Record<string, unknown>): ForkSettings {
  const settings = { ...FORK_DEFAULTS };
  for (const key of Object.keys(FORK_DEFAULTS) as (keyof ForkSettings)[]) {
    if (key === "speechVoice" || key === "liveVoice") continue;
    settings[key] = typeof record[key] === "boolean" ? record[key] : FORK_DEFAULTS[key];
  }
  // Composer extras was renamed Pi model picker once it held only the pi model menu
  if (typeof record["piModelPicker"] !== "boolean" && typeof record["composerExtras"] === "boolean") settings.piModelPicker = record["composerExtras"];
  settings.speechVoice = SPEECH_VOICES.find((voice) => voice === record["speechVoice"]) ?? FORK_DEFAULTS.speechVoice;
  settings.liveVoice = isPiVoice(record["liveVoice"]) ? record["liveVoice"] : FORK_DEFAULTS.liveVoice;
  return settings;
}

/** Only fork releases wrote these fields. Do not mistake an upstream record for a fork install. */
export function migrateForkSettings(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  if (!["contextCircle", "speechVoice", "liveVoice", "followOmarchy", "enterKey"].some((key) => Object.hasOwn(record, key))) return raw;
  const keyBarDefaults = Object.hasOwn(record, "keyBarItems") || Object.hasOwn(record, "keyBarExtras")
    ? {} : { keyBarItems: legacyKeyBarItems };
  // Once a new setting is explicit it always wins, including false and a reset to upstream defaults.
  return { phoneTabs: "header", ...keyBarDefaults, squareCorners: true, moreViewToggle: true,
    agentFriends: true, piModelPicker: true, chatMotion: true,
    piLiveVoice: true, computerView: true, pullRequests: true, inboxFooter: true, readAloud: true, notes: true, ...record };
}

/** Kept apart from the main record: an older upstream tab must not erase fork choices on save. */
const STORAGE_KEY = "ovis:fork-settings";
export function loadForkSettings(fallback: ForkSettings): ForkSettings {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    return typeof raw === "object" && raw !== null ? sanitizeForkSettings({ ...fallback, ...raw }) : fallback;
  } catch { return fallback; }
}

export function saveForkSettings(settings: ForkSettings): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeForkSettings({ ...settings })));
}

/** Attributes own all fork CSS; switching a feature off removes its styling immediately. */
export function applyForkSettings(settings: ForkSettings, root: HTMLElement): void {
  for (const key of Object.keys(FORK_DEFAULTS) as (keyof ForkSettings)[]) {
    if (typeof settings[key] === "boolean") root.dataset[`fork${key.charAt(0).toUpperCase()}${key.slice(1)}`] = String(settings[key]);
  }
}
