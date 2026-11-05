import { HERDR_DEFAULT_PREFIX, HERDR_PREFIX_ACTIONS, HERDR_PREFIX_DEFAULTS, type HerdrKeys } from "../shared/herdr-keys.ts";
import type { HerdrUiConfig } from "../shared/protocol.ts";
import { herdrConfigPath, readHerdrConfig } from "./herdr-sidebar.ts";

/**
 * The herdr client preferences of the PC serving this web UI that its own selection follows (#1559):
 * `[ui] copy_on_select`, read again on each request. herdr's default (on) stands for a config that
 * is missing, unreadable or no TOML, and for a value that is no boolean.
 */
export function readHerdrUi(path = herdrConfigPath()): HerdrUiConfig {
  const config = readHerdrConfig(path);
  const ui = typeof config === "object" && config !== null ? (config as { ui?: unknown }).ui : undefined;
  const copy = typeof ui === "object" && ui !== null ? (ui as { copy_on_select?: unknown }).copy_on_select : undefined;
  return { copy_on_select: typeof copy === "boolean" ? copy : true, keys: herdrKeys(config) };
}

/**
 * `[keys] prefix` and the bindings of the actions the app runs, read only: a missing or unreadable
 * config is herdr's defaults, as herdr falls back to them. A value that is no string is unbound here,
 * so nothing herdr would not run is run; `[[keys.command]]` bodies are never read.
 */
function herdrKeys(config: unknown): HerdrKeys {
  const keys = typeof config === "object" && config !== null ? (config as { keys?: unknown }).keys : undefined;
  const table = typeof keys === "object" && keys !== null && !Array.isArray(keys) ? keys as Record<string, unknown> : {};
  const value = (name: string, fallback: string): string => !Object.hasOwn(table, name) ? fallback : typeof table[name] === "string" ? table[name] : "";
  const bindings = Object.fromEntries(HERDR_PREFIX_ACTIONS.map((action) => [action, value(action, HERDR_PREFIX_DEFAULTS[action])])) as HerdrKeys["bindings"];
  return { prefix: value("prefix", HERDR_DEFAULT_PREFIX), bindings };
}
