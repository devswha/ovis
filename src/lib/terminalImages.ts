import { useEffect } from "react";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { IImageAddonOptions } from "@xterm/addon-image";

/**
 * Caps on what a pane's pictures may hold in this tab. Decoded pictures are RGBA in memory, four bytes
 * a pixel: the addon's own defaults (16 megapixels a picture, 128 MB stored) suit a desk, not a phone's
 * WebView, which a tab past its memory share is reloaded from. Past the stored cap the oldest picture
 * goes first; one larger than the pixel cap is not drawn at all.
 */
export function terminalImageOptions(coarse: boolean): IImageAddonOptions {
  return coarse
    ? { pixelLimit: 2048 * 2048, storageLimit: 16, sixelSizeLimit: 8_000_000, iipSizeLimit: 8_000_000 }
    : { pixelLimit: 4096 * 4096, storageLimit: 64 };
}

/**
 * Settings -> Terminal -> Pictures in the terminal: draws sixel and iTerm2 inline images (imgcat,
 * img2sixel, chafa, yazi) with xterm's image addon, loaded only once the setting is on. It does not
 * draw kitty's graphics protocol. The pictures reach the tab only where the attach stream carries
 * them: herdr-core passes a pane's output on as it is, herdr draws the pane from its own grid again
 * and drops them; a pane drawn again (attached anew) comes back without its pictures either way.
 */
export function useTerminalImages(terminal: Terminal | null, enabled: boolean, coarse: boolean): void {
  useEffect(() => {
    if (terminal === null || !enabled) return;
    let loaded: IDisposable[] = [];
    let gone = false;
    // the addon turns xterm's pixel size reports on (the bridge passes the cell size on to hc, which
    // answers the program with it); turned off, the terminal answers as it did before
    const windowOptions = { ...terminal.options.windowOptions };
    import("@xterm/addon-image").then(({ ImageAddon }) => {
      if (gone) return;
      const addon = new ImageAddon(terminalImageOptions(coarse));
      terminal.loadAddon(addon);
      // XTSMGRAPHICS goes unanswered, as without the addon: hc leaves it to its viewers, and two
      // browsers on one pane answered it late, into the program's next read (measured on hc 0.1.17)
      loaded = [addon, terminal.parser.registerCsiHandler({ prefix: "?", final: "S" }, () => true)];
    }, (error: unknown) => {
      console.error("terminal pictures could not be loaded", error);
    });
    // xterm disposes its addons with the terminal, and a second dispose is a no-op
    return () => {
      gone = true;
      if (loaded.length === 0) return;
      for (const disposable of loaded) disposable.dispose();
      terminal.options.windowOptions = windowOptions;
    };
  }, [terminal, enabled, coarse]);
}
