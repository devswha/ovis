/**
 * Whether the app updates itself, and from where. A packaged build does when it was built with a
 * feed (OVIS_UPDATE_FEED at build time writes electron-builder's app-update.yml); OVIS_UPDATE_URL
 * only replaces that feed, since electron-updater reads app-update.yml again when it downloads. A
 * development run never updates, and OVIS_UPDATES=0 turns it off. On Linux
 * the AppImage replaces itself, and a .deb install (electron-builder's `package-type` file in the
 * resources says `deb`) installs the downloaded .deb with apt-get behind the system's password prompt.
 *
 * The beta channel (the same setting as the server's: OVIS_UPDATE_CHANNEL, or `beta` in the
 * `update-channel` file of the server's state dir) takes the beta builds CI publishes from green
 * main (.github/workflows/beta.yml) from BETA_FEED instead. It is read when the app starts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppUpdater } from "electron-updater";
import { readUpdateChannel, type UpdateChannel } from "../../../shared/update.ts";

type Env = Record<string, string | undefined>;

/** The rolling `desktop-beta` prerelease the beta workflow uploads each beta build and its feed files to. */
export const BETA_FEED = "https://github.com/devswha/ovis/releases/download/desktop-beta";
/** The setting file in the server's state dir, the one server/updater.ts reads (UPDATE_CHANNEL_FILE). */
const CHANNEL_FILE = "update-channel";

/** which electron-updater class installs the update; "default" is its own pick for the platform */
export type Installer = "default" | "appimage" | "deb";

export type UpdatePlan = { enabled: false; reason: string } | { enabled: true; feed: string | null; channel: UpdateChannel; installer: Installer };

/**
 * How a downloaded .deb is installed (as root, behind the password prompt): apt-get resolves its
 * dependencies in the same command, fails when it did not install, and with --no-remove stops
 * rather than remove another package. No --allow-* flags: the feed only ever offers a newer
 * version, and a local file needs no repository signature.
 *
 * `file` is electron-updater's installerPath, escaped for one shell except for `'`. Behind the
 * prompt (`prompted`) it runs the command as `bash -c '<command>'`, where a `'` would end the
 * quotes: it goes in as `\'\''`. Run as root, one shell reads the command, and `\'` is enough.
 */
export function debInstallCommand(file: string, prompted: boolean): string[] {
  return ["apt-get", "install", "-y", "--no-remove", file.replace(/'/g, prompted ? "\\'\\''" : "\\'")];
}

/** OVIS_UPDATE_CHANNEL when it names a channel, else the state dir's `update-channel` file, else stable. */
export function updateChannel(env: Env, stateDir: string): UpdateChannel {
  const set = readUpdateChannel(env["OVIS_UPDATE_CHANNEL"]);
  if (set) return set;
  try { return readUpdateChannel(readFileSync(join(stateDir, CHANNEL_FILE), "utf8")) ?? "stable"; }
  catch { return "stable"; }
}

export function updatePlan(options: { packaged: boolean; env: Env; platform: string; builtWithFeed: boolean; channel?: UpdateChannel; linuxPackage?: string | null; execPath?: string }): UpdatePlan {
  const { env } = options;
  const channel = options.channel ?? "stable";
  if (["0", "false", "off", "no"].includes(env["OVIS_UPDATES"]?.trim().toLowerCase() ?? "")) return { enabled: false, reason: "turned off with OVIS_UPDATES" };
  if (!options.packaged) return { enabled: false, reason: "a development run" };
  // without app-update.yml electron-updater finds an update but fails to download it. Asked first:
  // a Linux package gets its package-type file only from a build with a feed
  if (!options.builtWithFeed) return { enabled: false, reason: "this build has no update feed" };
  let installer: Installer = "default";
  if (options.platform === "linux") {
    // chosen here, not by electron-updater: it goes by the package-type file alone, and electron-builder
    // writes that file into the folder the AppImage is also built from (whether the AppImage gets it
    // depends on which target builds first). An AppImage only when this program runs from its mount:
    // APPIMAGE alone may be left over from another AppImage that started this one, and the
    // AppImage updater would overwrite that file.
    // (an APPDIR of / would contain every program)
    const mount = env["APPDIR"]?.replace(/\/+$/, "");
    if (env["APPIMAGE"] && mount && options.execPath?.startsWith(`${mount}/`)) installer = "appimage";
    else if (options.linuxPackage === "deb") installer = "deb";
    else return { enabled: false, reason: "only the AppImage and the .deb install update themselves" };
  }
  const override = env["OVIS_UPDATE_URL"]?.trim();
  if (override) {
    let url: URL;
    try { url = new URL(override); } catch { return { enabled: false, reason: `OVIS_UPDATE_URL is not an address: ${override}` }; }
    if (url.protocol !== "https:") return { enabled: false, reason: "OVIS_UPDATE_URL must be an https address" };
    return { enabled: true, feed: url.href, channel, installer };
  }
  // the beta workflow builds no Windows app yet, so its feed has none: Windows stays on the release
  // feed and its stable channel (latest.yml), since the release publishes no beta.yml
  if (channel === "beta" && options.platform === "win32") return { enabled: true, feed: null, channel: "stable", installer };
  return { enabled: true, feed: channel === "beta" ? BETA_FEED : null, channel, installer };
}

/**
 * How often the app asks its feed, after the check it makes as it starts: no release is pushed to
 * the app, so this is how long one can go unheard of.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** The update the app holds, downloaded and waiting for Restart to Update: its version and electron-updater's file. */
export interface HeldUpdate {
  version: string;
  file: string;
}

/**
 * The update the app still holds: none once its file is gone. A later download that fails empties
 * electron-updater's folder, the held file with it, and Restart to Update would then stop the
 * server and find nothing to install.
 */
export function stillHeld<Held extends HeldUpdate>(held: Held | null, exists: (file: string) => boolean): Held | null {
  return held !== null && exists(held.file) ? held : null;
}

/**
 * Whether a check downloads the version the feed names (`found`). Not the one the app already
 * holds: electron-updater answers that download with the file it has and says "update-downloaded"
 * again, every check (on a Mac it copies the zip and hands it to Squirrel again first). A held
 * file that is gone is downloaded again, and so is anything once the updater reported an error
 * (`failed`): whatever failed, a Mac's staging of the download too, gets the try it always got.
 */
export function downloadsUpdate(check: { found: string; held: HeldUpdate | null; failed: boolean; exists: (file: string) => boolean }): boolean {
  return check.failed || stillHeld(check.held, check.exists)?.version !== check.found;
}

/**
 * One check of the feed, as the app runs it after it starts and every hour
 * (UPDATE_CHECK_INTERVAL_MS), for an updater whose `autoDownload` is off: the version found is
 * downloaded here, unless `wanted` says no (the app holds it already). A failed check is logged.
 * The updater's error event already reports a failed download (a cancelled one is no error): the
 * promise of that download is only caught, where left alone it was logged a second time as an
 * unhandled rejection (#2831). A download that fails before it begins (a feed that names a version
 * with no file for this app) throws instead, with no event, and is logged here.
 */
export async function checkForUpdates(updater: Pick<AppUpdater, "checkForUpdates" | "downloadUpdate">, log: (line: string) => void, wanted: (version: string) => boolean = () => true): Promise<void> {
  const told = (error: unknown) => error instanceof Error ? error.message : String(error);
  const result = await updater.checkForUpdates().catch((error: unknown) => {
    log(`Update check failed: ${told(error)}`);
    return null;
  });
  if (!result?.isUpdateAvailable || !wanted(result.updateInfo.version)) return;
  let download: Promise<unknown>;
  try {
    download = updater.downloadUpdate(result.cancellationToken);
  } catch (error) {
    log(`Update download failed: ${told(error)}`);
    return;
  }
  await download.catch(() => {});
}

/**
 * What the app has said about a downloaded update, kept in `<user data>/update-notice.json` so a
 * version is announced once, also across starts (a .deb installs only from Restart to Update, so
 * the same download is found again by every start until then).
 */
export interface UpdateNotices {
  /** the version whose system notification was shown */
  notified: string | null;
  /** the version whose line in the window was closed */
  closed: string | null;
}

export function readUpdateNotices(path: string): UpdateNotices {
  const saved = ((): Partial<Record<keyof UpdateNotices, unknown>> | null => {
    try { return JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof UpdateNotices, unknown>> | null; } catch { return null; }
  })();
  const version = (value: unknown) => typeof value === "string" && value !== "" ? value : null;
  return { notified: version(saved?.notified), closed: version(saved?.closed) };
}

export function writeUpdateNotices(path: string, notices: UpdateNotices): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(notices));
  renameSync(temporary, path);
}

/**
 * What a downloaded update still has to say: one system notification per version, and its line
 * in the window until that line is closed for the version. The tray's Restart to Update stays
 * either way, and a later version is announced afresh.
 */
export function updateNotice(version: string, said: UpdateNotices): { notify: boolean; line: boolean } {
  return { notify: said.notified !== version, line: said.closed !== version };
}
