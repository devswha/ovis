import { describe, expect, it } from "bun:test";
import { extractedAppDir } from "./appimage.ts";

describe("extractedAppDir", () => {
  const dir = "/tmp/appimage_extracted_ee741acd1144844bf97841d03808ecdd";
  const env = { APPIMAGE: "/home/u/Ovis-linux-x64.AppImage", APPDIR: dir, APPIMAGE_EXTRACT_AND_RUN: "1" };

  it("names the folder this AppImage unpacked itself into to run without FUSE", () => {
    expect(extractedAppDir(env, `${dir}/ovis`)).toBe(dir);
    expect(extractedAppDir({ ...env, APPDIR: `${dir}/` }, `${dir}/ovis`)).toBe(dir);
  });

  it("leaves a FUSE mount, a .deb install and another AppImage's folder alone", () => {
    expect(extractedAppDir({ ...env, APPDIR: "/tmp/.mount_OvisAb" }, "/tmp/.mount_OvisAb/ovis")).toBeNull();
    expect(extractedAppDir({}, "/opt/Ovis/ovis")).toBeNull();
    // started from an unpacked AppImage of another program: its APPDIR is not where this one runs
    expect(extractedAppDir(env, "/opt/Ovis/ovis")).toBeNull();
    expect(extractedAppDir({ ...env, APPIMAGE: undefined }, `${dir}/ovis`)).toBeNull();
    expect(extractedAppDir({ ...env, APPDIR: "/tmp/appimage_extracted_x/../home" }, "/tmp/appimage_extracted_x/../home/ovis")).toBeNull();
  });
});
