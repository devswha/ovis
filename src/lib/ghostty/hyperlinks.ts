import type { ILink, ILinkProvider } from "@xterm/xterm";
import type { ScreenRows } from "../terminalScreen.ts";

/**
 * The OSC 8 hyperlinks (`ESC ] 8 ; ; uri`) of a row of libghostty's, as xterm's own link provider finds them in its
 * buffer: each run of cells with one target is a link. xterm's rows carry none here (they have no `hyperlink`), so a
 * pane whose bytes xterm no longer parses keeps its hyperlinks.
 */
export function hyperlinkProvider(rows: () => ScreenRows, activate: (event: MouseEvent, uri: string) => void): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = rows().getLine(y - 1);
      if (!line?.hyperlink) { callback(undefined); return; }
      const links: ILink[] = [];
      let uri: string | null = null;
      let start = 0;
      for (let x = 0; x <= line.length; x++) {
        const here = x < line.length ? line.hyperlink(x) : null;
        if (here === uri) continue;
        if (uri !== null) {
          const target = uri;
          links.push({ range: { start: { x: start + 1, y }, end: { x, y } }, text: target, activate: (event) => activate(event, target) });
        }
        uri = here;
        start = x;
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
