import { homedir } from "node:os";

/**
 * The user's home, where agents keep their stores and skills: HOME, else USERPROFILE (native
 * Windows often sets no HOME), else the OS's answer on Windows. Read, never written back to the
 * environment: Git and the other tools the server starts pick their own home on Windows
 * (HOMEDRIVE/HOMEPATH first).
 */
export function userHome(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  return env["HOME"] || env["USERPROFILE"] || (platform === "win32" ? homedir() : "");
}
