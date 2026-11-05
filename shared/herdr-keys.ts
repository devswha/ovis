/**
 * herdr's prefix-mode actions the app can run itself (Settings → Shortcuts → Use herdr's prefix keys),
 * with herdr 0.9.5's defaults (`[keys]` in its config template). "" is unbound, as in herdr's config.
 * Every other herdr action, direct (non-prefix) binding and `[[keys.command]]` is left to herdr.
 */
export const HERDR_PREFIX_DEFAULTS = {
  help: "prefix+?",
  settings: "prefix+s",
  workspace_picker: "prefix+w",
  goto: "prefix+g",
  new_workspace: "prefix+shift+n",
  previous_workspace: "",
  next_workspace: "",
  new_tab: "prefix+c",
  rename_tab: "prefix+shift+t",
  previous_tab: "prefix+p",
  next_tab: "prefix+n",
  switch_tab: "prefix+1..9",
  split_vertical: "prefix+v",
  split_horizontal: "prefix+minus",
  zoom: "prefix+z",
  toggle_sidebar: "prefix+b",
} as const;

export type HerdrPrefixAction = keyof typeof HERDR_PREFIX_DEFAULTS;

export const HERDR_PREFIX_ACTIONS = Object.keys(HERDR_PREFIX_DEFAULTS) as HerdrPrefixAction[];

export const HERDR_DEFAULT_PREFIX = "ctrl+b";

/** herdr's prefix and the bindings of HERDR_PREFIX_ACTIONS, as written in its config or defaulted. */
export interface HerdrKeys {
  prefix: string;
  bindings: Record<HerdrPrefixAction, string>;
}
