/**
 * Whether the app updates itself, and from where. A packaged build does when it was built with a
 * feed (OVIS_UPDATE_FEED at build time writes electron-builder's app-update.yml) or is started
 * with OVIS_UPDATE_URL; a development run never does, and OVIS_UPDATES=0 turns it off. On Linux
 * the AppImage replaces itself, and a .deb install (electron-builder's `package-type` file in the
 * resources says `deb`) installs the downloaded .deb with dpkg behind the system's password prompt.
 */
type Env = Record<string, string | undefined>;

/** which electron-updater class installs the update; "default" is its own pick for the platform */
export type Installer = "default" | "appimage" | "deb";

export type UpdatePlan = { enabled: false; reason: string } | { enabled: true; feed: string | null; installer: Installer };

export function updatePlan(options: { packaged: boolean; env: Env; platform: string; builtWithFeed: boolean; linuxPackage?: string | null }): UpdatePlan {
  const { env } = options;
  if (["0", "false", "off", "no"].includes(env["OVIS_UPDATES"]?.trim().toLowerCase() ?? "")) return { enabled: false, reason: "turned off with OVIS_UPDATES" };
  if (!options.packaged) return { enabled: false, reason: "a development run" };
  let installer: Installer = "default";
  if (options.platform === "linux") {
    // chosen here, not by electron-updater: it goes by the package-type file alone, and electron-builder
    // writes that file into the folder the AppImage is also built from (whether the AppImage gets it
    // depends on which target builds first)
    if (env["APPIMAGE"]) installer = "appimage";
    else if (options.linuxPackage === "deb") installer = "deb";
    else return { enabled: false, reason: "only the AppImage and the .deb install update themselves" };
  }
  const override = env["OVIS_UPDATE_URL"]?.trim();
  if (override) {
    let url: URL;
    try { url = new URL(override); } catch { return { enabled: false, reason: `OVIS_UPDATE_URL is not an address: ${override}` }; }
    if (url.protocol !== "https:") return { enabled: false, reason: "OVIS_UPDATE_URL must be an https address" };
    return { enabled: true, feed: url.href, installer };
  }
  if (options.builtWithFeed) return { enabled: true, feed: null, installer };
  return { enabled: false, reason: "this build has no update feed" };
}
