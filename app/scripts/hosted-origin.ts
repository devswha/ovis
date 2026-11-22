/**
 * The hosted shell's origin a build of the phone apps takes: OVIS_APP_URL, for a test build whose relay pairing links
 * point at a shell served elsewhere, else each part keeps its own https://app.ovis.sh. build-web.ts gives it to the
 * app's pages (APP_ORIGIN in web/shell.js) and, through the files below, to the native code: BuildConfig.APP_ORIGIN
 * on Android (android/app/build.gradle reads hosted-origin.properties) and OvisAppOrigin in the iOS app's Info.plist
 * (ios/hosted-origin.xcconfig includes hosted-origin.generated.xcconfig), so a build cannot give them two origins.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `value` when it is an https origin with no path, null when it is unset or empty; anything else throws. */
export function appOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: URL | null = null;
  try { parsed = new URL(value); } catch {}
  if (parsed?.protocol !== "https:" || parsed.origin !== value) throw new Error(`OVIS_APP_URL must be an https origin with no path, such as https://app.ovis.sh: ${value}`);
  return value;
}

/** Writes `origin` where the native builds of `app` read it, or removes it (null) so they take their own default. */
export function writeNativeOrigin(app: string, origin: string | null): void {
  const android = join(app, "android/app/hosted-origin.properties");
  const ios = join(app, "ios/hosted-origin.generated.xcconfig");
  if (origin === null) {
    rmSync(android, { force: true });
    rmSync(ios, { force: true });
    return;
  }
  writeFileSync(android, `appOrigin=${origin}\n`);
  // "//" starts a comment in an xcconfig file; "$()" expands to nothing
  writeFileSync(ios, `OVIS_APP_ORIGIN = ${origin.replace("//", "/$()/")}\n`);
}
