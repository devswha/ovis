import { describe, expect, it } from "bun:test";
import { updatePlan } from "./updates.ts";

const packaged = { packaged: true, platform: "darwin", builtWithFeed: true, env: {} };

describe("updatePlan", () => {
  it("updates a packaged build from the feed it was built with", () => {
    expect(updatePlan(packaged)).toEqual({ enabled: true, feed: null, installer: "default" });
  });

  it("never updates a development run, or with OVIS_UPDATES=0", () => {
    expect(updatePlan({ ...packaged, packaged: false }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATES: "0" } }).enabled).toBe(false);
  });

  it("has nothing to update from without a feed", () => {
    expect(updatePlan({ ...packaged, builtWithFeed: false })).toEqual({ enabled: false, reason: "this build has no update feed" });
  });

  it("takes OVIS_UPDATE_URL over the built feed, https only", () => {
    expect(updatePlan({ ...packaged, builtWithFeed: false, env: { OVIS_UPDATE_URL: "https://updates.example/desktop" } })).toEqual({ enabled: true, feed: "https://updates.example/desktop", installer: "default" });
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "http://updates.example/desktop" } }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "not an address" } }).enabled).toBe(false);
  });

  it("updates on Linux as an AppImage or a .deb install, each with its own installer", () => {
    const linux = { ...packaged, platform: "linux" };
    expect(updatePlan(linux).enabled).toBe(false);
    expect(updatePlan({ ...linux, linuxPackage: "rpm" }).enabled).toBe(false);
    const appImage = { env: { APPIMAGE: "/home/u/Ovis.AppImage", APPDIR: "/tmp/.mount_OvisAb" }, execPath: "/tmp/.mount_OvisAb/ovis" };
    expect(updatePlan({ ...linux, ...appImage })).toEqual({ enabled: true, feed: null, installer: "appimage" });
    expect(updatePlan({ ...linux, linuxPackage: "deb", execPath: "/opt/Ovis/ovis" })).toEqual({ enabled: true, feed: null, installer: "deb" });
    // electron-builder may leave the deb's package-type file in the AppImage too: a running AppImage stays one
    expect(updatePlan({ ...linux, ...appImage, linuxPackage: "deb" })).toEqual({ enabled: true, feed: null, installer: "appimage" });
    // started from another AppImage (a terminal, an editor): its APPIMAGE and APPDIR are not this program's
    const inherited = { APPIMAGE: "/home/u/Terminal.AppImage", APPDIR: "/tmp/.mount_TermXy" };
    expect(updatePlan({ ...linux, linuxPackage: "deb", execPath: "/opt/Ovis/ovis", env: inherited })).toEqual({ enabled: true, feed: null, installer: "deb" });
    expect(updatePlan({ ...linux, execPath: "/opt/Ovis/ovis", env: inherited }).enabled).toBe(false);
  });
});
