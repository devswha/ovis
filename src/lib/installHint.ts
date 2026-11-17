export type InstallHintKind = "ios" | "android";

export interface InstallHintEnvironment {
  userAgent: string;
  /** iPadOS reports a Mac user agent; touch points tell the two apart */
  maxTouchPoints: number;
  secure: boolean;
  installed: boolean;
  nativeApp: boolean;
  dismissed: boolean;
}

export function installHintKind(env: InstallHintEnvironment): InstallHintKind | null {
  if (env.installed || env.nativeApp || env.dismissed || !env.secure) return null;
  if (/iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(env.userAgent)) return "android";
  return null;
}

const KEY = "ovis:install-hint-dismissed";

export function readHintDismissed(): boolean {
  try { return window.localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function writeHintDismissed(): void {
  try { window.localStorage.setItem(KEY, "1"); } catch { }
}
