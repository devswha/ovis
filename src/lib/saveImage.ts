/**
 * Saving a picture where a download link would not save it (#3118). The iOS app's web view has no
 * download handler, so Capacitor lets a link to the PC's own address in as a page, and a
 * home-screen web app follows it the same way: the picture replaced the app, with no way back.
 * There the picture goes to the share sheet instead, whose Save Image keeps it. Everywhere else the
 * link downloads as before.
 */
import { inAndroidApp, inNativeApp } from "./nativeApp.ts";

/** Whether a download link here would load the file over the app instead of saving it. */
export function downloadLeavesApp(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || (inNativeApp() && !inAndroidApp());
}

/** The picture at `url` (a PC path, a blob: or a data: URL) as a file named `name`. */
export async function imageFile(url: string, name: string, signal?: AbortSignal): Promise<File> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

export type ShareOutcome = "shared" | "cancelled" | "failed";

/**
 * Offers `file` to the share sheet. WebKit opens it only within the tap that asked, so the file
 * must be in hand before the tap: call this first thing in the click.
 */
export async function shareFile(file: File): Promise<ShareOutcome> {
  const data = { files: [file] };
  if (typeof navigator.share !== "function" || navigator.canShare?.(data) === false) return "failed";
  try {
    await navigator.share(data);
    return "shared";
  } catch (error) {
    return error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
  }
}
