import { GitFork } from "lucide-react";

import type { Translate } from "../../lib/i18n.ts";

/** Settings → Fork, last before About (SettingsDialog.tsx lists it, paletteSettings.ts finds it). */
export const FORK_PAGE = { id: "fork", icon: GitFork } as const;
export const forkPageLabel = (t: Translate): string => t("Fork|settings");
export const forkPageNote = (t: Translate): string => t("What this fork adds to Ovis. Each choice is this device's own unless it says otherwise.");
