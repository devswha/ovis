/**
 * Imported first by every server entry point, before any module reads its settings: the settings
 * this process was started with under their names from before the rename (legacy-env.ts) fill
 * the OVIS_* names they now go by.
 */
import { homedir } from "node:os";
import { adoptLegacyEnv } from "./legacy-env.ts";

adoptLegacyEnv(process.env);

if (process.platform === "win32" && !process.env["HOME"]) {
  process.env["HOME"] = process.env["USERPROFILE"] || homedir();
}
