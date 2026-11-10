import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// not the package itself: it sets up an updater for this platform as its exports are read, which needs Electron
import { DebUpdater } from "electron-updater/out/DebUpdater";
import { BETA_FEED, checkForUpdates, debInstallCommand, downloadsUpdate, readUpdateNotices, stillHeld, UPDATE_CHECK_INTERVAL_MS, updateChannel, updateNotice, updatePlan, writeUpdateNotices } from "./updates.ts";

const packaged = { packaged: true, platform: "darwin", builtWithFeed: true, env: {} };

describe("updatePlan", () => {
  it("updates a packaged build from the feed it was built with", () => {
    expect(updatePlan(packaged)).toEqual({ enabled: true, feed: null, channel: "stable", installer: "default" });
  });

  it("never updates a development run, or with OVIS_UPDATES=0", () => {
    expect(updatePlan({ ...packaged, packaged: false }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATES: "0" } }).enabled).toBe(false);
  });

  it("has nothing to update from without a feed", () => {
    expect(updatePlan({ ...packaged, builtWithFeed: false })).toEqual({ enabled: false, reason: "this build has no update feed" });
  });

  it("says a Linux package built without a feed has none, since only a build with a feed carries the package-type file", () => {
    expect(updatePlan({ ...packaged, platform: "linux", builtWithFeed: false, execPath: "/opt/Ovis/ovis" })).toEqual({ enabled: false, reason: "this build has no update feed" });
  });

  it("takes OVIS_UPDATE_URL over the built feed, https only", () => {
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "https://updates.example/desktop" } })).toEqual({ enabled: true, feed: "https://updates.example/desktop", channel: "stable", installer: "default" });
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "http://updates.example/desktop" } }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "not an address" } }).enabled).toBe(false);
  });

  it("leaves a build without a feed off under OVIS_UPDATE_URL, since electron-updater downloads only with app-update.yml", () => {
    expect(updatePlan({ ...packaged, builtWithFeed: false, env: { OVIS_UPDATE_URL: "https://updates.example/desktop" } })).toEqual({ enabled: false, reason: "this build has no update feed" });
  });

  it("updates on Linux as an AppImage or a .deb install, each with its own installer", () => {
    const linux = { ...packaged, platform: "linux" };
    const plan = (installer: "appimage" | "deb") => ({ enabled: true, feed: null, channel: "stable", installer }) as const;
    expect(updatePlan(linux).enabled).toBe(false);
    expect(updatePlan({ ...linux, linuxPackage: "rpm" }).enabled).toBe(false);
    const appImage = { env: { APPIMAGE: "/home/u/Ovis.AppImage", APPDIR: "/tmp/.mount_OvisAb" }, execPath: "/tmp/.mount_OvisAb/ovis" };
    expect(updatePlan({ ...linux, ...appImage })).toEqual(plan("appimage"));
    expect(updatePlan({ ...linux, linuxPackage: "deb", execPath: "/opt/Ovis/ovis" })).toEqual(plan("deb"));
    // electron-builder may leave the deb's package-type file in the AppImage too: a running AppImage stays one
    expect(updatePlan({ ...linux, ...appImage, linuxPackage: "deb" })).toEqual(plan("appimage"));
    // started from another AppImage (a terminal, an editor): its APPIMAGE and APPDIR are not this program's
    const inherited = { APPIMAGE: "/home/u/Terminal.AppImage", APPDIR: "/tmp/.mount_TermXy" };
    expect(updatePlan({ ...linux, linuxPackage: "deb", execPath: "/opt/Ovis/ovis", env: inherited })).toEqual(plan("deb"));
    expect(updatePlan({ ...linux, execPath: "/opt/Ovis/ovis", env: inherited }).enabled).toBe(false);
    // an inherited APPDIR of / would contain every program
    expect(updatePlan({ ...linux, linuxPackage: "deb", execPath: "/opt/Ovis/ovis", env: { APPIMAGE: "/home/u/Other.AppImage", APPDIR: "/" } })).toEqual(plan("deb"));
  });

  it("takes the beta builds from the beta feed only on the beta channel", () => {
    expect(updatePlan({ ...packaged, channel: "beta" })).toEqual({ enabled: true, feed: BETA_FEED, channel: "beta", installer: "default" });
    expect(updatePlan({ ...packaged, channel: "stable" })).toEqual({ enabled: true, feed: null, channel: "stable", installer: "default" });
    // a build without a feed stays off, and OVIS_UPDATE_URL stays the feed on beta
    expect(updatePlan({ ...packaged, builtWithFeed: false, channel: "beta" }).enabled).toBe(false);
    // no Windows build is published to the beta feed: a Windows app on beta keeps the release feed and its
    // stable channel, since asking the release feed for beta.yml finds nothing
    expect(updatePlan({ ...packaged, platform: "win32", channel: "beta" })).toEqual({ enabled: true, feed: null, channel: "stable", installer: "default" });
    expect(updatePlan({ ...packaged, channel: "beta", env: { OVIS_UPDATE_URL: "https://updates.example/desktop" } })).toEqual({ enabled: true, feed: "https://updates.example/desktop", channel: "beta", installer: "default" });
  });
});

// the deb's install line is run by a POSIX shell, which a Windows runner does not have at /bin/sh
describe.skipIf(process.platform === "win32")("debInstallCommand", () => {
  // electron-updater's installerPath (LinuxUpdater) escapes these for one shell, but leaves ' alone
  const escaped = (path: string) => path.replace(/\\/g, "\\\\").replace(/([`$!" ;|&()<>])/g, "\\$1");
  const printed = (shellLine: string) => Bun.spawnSync(["/bin/sh", "-c", shellLine]).stdout.toString();
  const path = "/home/O'Brien/.cache/my app (1)/Ovis-linux-x64.deb";

  it("hands apt-get the whole path behind the prompt's bash -c '…', and when Ovis already runs as root", () => {
    // how electron-updater runs it: `pkexec … /bin/bash -c '<command>'`, or the command alone as root, both through a shell
    const prompted = debInstallCommand(escaped(path), true).at(-1);
    expect(printed(`/bin/bash -c 'printf %s ${prompted}'`)).toBe(path);
    const asRoot = debInstallCommand(escaped(path), false).at(-1);
    expect(printed(`printf %s ${asRoot}`)).toBe(path);
  });
});

describe("checkForUpdates", () => {
  it("leaves a failed download to the updater's error event, never an unhandled rejection", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-desktop-check-"));
    try {
      // a packaged build with a feed, offering a newer .deb whose download fails
      const app = { version: "0.4.22", name: "Ovis", isPackaged: true, appUpdateConfigPath: join(root, "resources", "app-update.yml"),
        userDataPath: join(root, "user-data"), baseCachePath: join(root, "cache"), whenReady: () => Promise.resolve(), quit() {}, relaunch() {}, onQuit() {} };
      mkdirSync(join(root, "resources"));
      writeFileSync(app.appUpdateConfigPath, "provider: generic\nurl: https://updates.example/desktop\nupdaterCacheDirName: ovis-desktop-updater\n");
      const httpExecutor = {
        request: async () => "version: 99.0.0\nfiles:\n  - url: Ovis-linux-x64.deb\n    sha512: c2hhNTEy\n    size: 12\n",
        download: async () => { throw new Error("connection reset"); },
      };
      // as the app sets it up: the check downloads what it found itself
      const updater = Object.assign(new DebUpdater(null, app), { httpExecutor, logger: null, autoInstallOnAppQuit: false, autoDownload: false });
      const failed = new Promise<string>((resolve) => updater.on("error", (error: Error) => resolve(error.message)));
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        const lines: string[] = [];
        await checkForUpdates(updater, (line) => lines.push(line));
        expect(await failed).toBe("connection reset");
        // a rejection nobody handles is reported once the turn's own work is done
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
        expect(lines).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** a stand-in updater whose feed names `version` (null: nothing newer), counting the downloads asked of it */
  const feed = (version: string | null) => {
    const asked = { checks: 0, downloads: 0 };
    const updater: Parameters<typeof checkForUpdates>[0] = {
      checkForUpdates: async () => {
        asked.checks += 1;
        const updateInfo = { version: version ?? "0.4.22", files: [], path: "", sha512: "", releaseDate: "" };
        return { isUpdateAvailable: version !== null, updateInfo, versionInfo: updateInfo };
      },
      downloadUpdate: async () => { asked.downloads += 1; return []; },
    };
    return { updater, asked };
  };

  it("logs a check that fails, and downloads nothing", async () => {
    const lines: string[] = [];
    let downloads = 0;
    await checkForUpdates({ checkForUpdates: () => Promise.reject(new Error("feed is down")), downloadUpdate: async () => { downloads += 1; return []; } }, (line) => lines.push(line));
    expect(lines).toEqual(["Update check failed: feed is down"]);
    expect(downloads).toBe(0);
  });

  it("downloads the version a check found, and nothing when the feed has no newer one", async () => {
    const newer = feed("0.5.3");
    await checkForUpdates(newer.updater, () => {});
    expect(newer.asked).toEqual({ checks: 1, downloads: 1 });
    const same = feed(null);
    await checkForUpdates(same.updater, () => {});
    expect(same.asked).toEqual({ checks: 1, downloads: 0 });
  });

  it("checks every hour without downloading the version the app already holds", async () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
    const { updater, asked } = feed("0.5.3");
    const held = { version: "0.5.3", file: "/cache/pending/Ovis-linux-x64.AppImage" };
    const versions: string[] = [];
    for (let hour = 0; hour < 3; hour += 1) {
      await checkForUpdates(updater, () => {}, (version) => { versions.push(version); return downloadsUpdate({ found: version, held, failed: false, exists: () => true }); });
    }
    expect(asked).toEqual({ checks: 3, downloads: 0 });
    expect(versions).toEqual(["0.5.3", "0.5.3", "0.5.3"]);
  });

  it("logs a download that fails before it begins, which the updater reports with no event", async () => {
    // electron-updater's downloadUpdate is not async: a feed that names a version with no file for this app throws out of it
    const { updater } = feed("0.5.3");
    const broken = { ...updater, downloadUpdate: (): Promise<string[]> => { throw new Error("No files provided: latest-linux.yml"); } };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const lines: string[] = [];
      await checkForUpdates(broken, (line) => lines.push(line));
      await new Promise((resolve) => setImmediate(resolve));
      expect(lines).toEqual(["Update download failed: No files provided: latest-linux.yml"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("downloadsUpdate", () => {
  const held = { version: "0.5.3", file: "/cache/pending/Ovis-linux-x64.deb" };
  const there = () => true;
  const quiet = { failed: false, exists: there };

  it("downloads a version while the app holds none, or another one", () => {
    expect(downloadsUpdate({ ...quiet, found: "0.5.3", held: null })).toBe(true);
    expect(downloadsUpdate({ ...quiet, found: "0.5.4", held })).toBe(true);
  });

  it("leaves the version it holds alone, so a check does not announce it again", () => {
    const asked: string[] = [];
    expect(downloadsUpdate({ found: "0.5.3", held, failed: false, exists: (file) => { asked.push(file); return true; } })).toBe(false);
    expect(asked).toEqual([held.file]);
  });

  it("downloads the held version again once its file is gone", () => {
    expect(downloadsUpdate({ found: "0.5.3", held, failed: false, exists: () => false })).toBe(true);
  });

  it("downloads the held version again after the updater reported an error, as electron-updater alone would", () => {
    expect(downloadsUpdate({ found: "0.5.3", held, failed: true, exists: there })).toBe(true);
  });
});

describe("stillHeld", () => {
  const held = { version: "0.5.3", file: "/cache/pending/Ovis-linux-x64.AppImage", install: () => undefined };

  it("keeps the update while its file is there, with what installs it", () => {
    expect(stillHeld(held, () => true)).toBe(held);
  });

  it("holds nothing once the file is gone: a later download that failed emptied the updater's folder", () => {
    expect(stillHeld(held, () => false)).toBeNull();
    expect(stillHeld(null, () => true)).toBeNull();
  });
});

describe("updateNotice", () => {
  const nothing = { notified: null, closed: null };

  it("notifies of a version once, and keeps its line until that is closed", () => {
    expect(updateNotice("0.5.3", nothing)).toEqual({ notify: true, line: true });
    expect(updateNotice("0.5.3", { notified: "0.5.3", closed: null })).toEqual({ notify: false, line: true });
    expect(updateNotice("0.5.3", { notified: "0.5.3", closed: "0.5.3" })).toEqual({ notify: false, line: false });
  });

  it("announces the next version afresh", () => {
    expect(updateNotice("0.5.4", { notified: "0.5.3", closed: "0.5.3" })).toEqual({ notify: true, line: true });
    // a beta build is a version of its own
    expect(updateNotice("0.5.4-beta.2", { notified: "0.5.4-beta.1", closed: "0.5.4-beta.1" })).toEqual({ notify: true, line: true });
  });

  it("remembers what it said across starts, and starts from nothing with no file or a damaged one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-desktop-notice-"));
    try {
      const path = join(dir, "user-data", "update-notice.json");
      expect(readUpdateNotices(path)).toEqual(nothing);
      writeUpdateNotices(path, { notified: "0.5.3", closed: null });
      expect(readUpdateNotices(path)).toEqual({ notified: "0.5.3", closed: null });
      // the same download found again by the next start (a .deb installs only from Restart to Update)
      expect(updateNotice("0.5.3", readUpdateNotices(path)).notify).toBe(false);
      for (const damaged of ["", "null", "[]", "{\"notified\": 3, \"closed\": \"\"}", "{not json"]) {
        writeFileSync(path, damaged);
        expect(readUpdateNotices(path)).toEqual(nothing);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("updateChannel", () => {
  it("reads OVIS_UPDATE_CHANNEL, then the server state dir's update-channel file, else stable", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-desktop-channel-"));
    try {
      expect(updateChannel({}, stateDir)).toBe("stable");
      writeFileSync(join(stateDir, "update-channel"), "beta\n");
      expect(updateChannel({}, stateDir)).toBe("beta");
      expect(updateChannel({ OVIS_UPDATE_CHANNEL: "stable" }, stateDir)).toBe("stable");
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});
