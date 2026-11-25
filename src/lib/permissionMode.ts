import type { Translate } from "./i18n.ts";

/**
 * Claude Code's permission mode as the composer's pill names it: nothing for its default mode (or none told), the name
 * of each mode it has, and a mode it names otherwise as it named it.
 */
export function permissionModeLabel(mode: string | undefined, t: Translate): string | null {
  switch (mode) {
    case undefined: case "default": return null;
    case "plan": return t("Plan mode");
    case "acceptEdits": return t("Accept edits");
    case "auto": return t("Auto mode");
    case "bypassPermissions": return t("Bypass permissions");
    case "dontAsk": return t("Don't ask");
    default: return mode;
  }
}
