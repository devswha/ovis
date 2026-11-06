import { basename } from "node:path";

/**
 * The folder this AppImage unpacked itself into to run without FUSE (`--appimage-extract-and-run`
 * or APPIMAGE_EXTRACT_AND_RUN=1, the fallback where user FUSE mounts are not allowed), when this
 * program runs from it; null otherwise. The runtime names it `appimage_extracted_<hash>` in the
 * temporary folder and is meant to remove it after the app exits, but it was seen left behind
 * (about 400 MB), so the app removes it as it quits.
 */
export function extractedAppDir(env: Record<string, string | undefined>, execPath: string): string | null {
  const dir = env["APPDIR"]?.replace(/\/+$/, "");
  if (!env["APPIMAGE"] || !dir || !/^appimage_extracted_[0-9a-f]+$/.test(basename(dir))) return null;
  return execPath.startsWith(`${dir}/`) ? dir : null;
}
