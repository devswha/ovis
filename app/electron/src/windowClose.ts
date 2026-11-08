/** What hiding needs from a window (a BrowserWindow has it all). */
export interface HideableWindow {
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  once(event: "leave-full-screen", listener: () => void): unknown;
  hide(): void;
}

/**
 * Hides the window a close keeps in the tray. On macOS a full-screen window leaves full screen first and
 * hides once it has: hidden in full screen, its Space stays behind as a black screen (electron/electron#20263).
 */
export function hideWindow(window: HideableWindow, platform: NodeJS.Platform): void {
  if (platform !== "darwin" || !window.isFullScreen()) {
    window.hide();
    return;
  }
  window.once("leave-full-screen", () => window.hide());
  window.setFullScreen(false);
}
