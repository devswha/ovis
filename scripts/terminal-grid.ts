import { join } from "node:path";
import type { Page } from "playwright-core";
import type { ClientMessage } from "../shared/protocol.ts";
import { buildDemoApp } from "./demo-build.ts";

type Grid = { readonly cols: number; readonly rows: number };
type Frame = Grid & { readonly pane: string; readonly replay: boolean };
type Witness = { attach: number; requested: Grid | null; parsed: Frame | null };

declare global {
  interface Window { terminalGridWitness?: Witness }
}

/** Serve the existing hook-enabled client against the real bridge, without the demo transport. */
export async function gridTestServer(root: string) {
  await buildDemoApp(join(root, "dist"));
  process.env["OVIS_ASSETS"] = root;
  const [{ createServer }, { UsageService }] = await Promise.all([
    import("../server/index.ts"), import("../server/usage.ts"),
  ]);
  return createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"),
    tailscaleOwner: null, usage: new UsageService(undefined, []) });
}

/** Observe the requested grid and the browser's post-parse witness, without reading PTY bytes. */
export async function terminalGrid(page: Page, pane: string) {
  await page.addInitScript(pane => {
    const witness: Witness = { attach: 0, requested: null, parsed: null };
    window.terminalGridWitness = witness;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        const message: ClientMessage = JSON.parse(data);
        if ("pane_id" in message && message.pane_id === pane) {
          if (message.type === "attach" || message.type === "detach") {
            witness.requested = message.type === "attach" && !message.keep_size ? { cols: message.cols, rows: message.rows } : null;
            witness.parsed = null;
            if (witness.requested) witness.attach++;
          } else if (message.type === "resize" && witness.requested &&
            (message.cols !== witness.requested.cols || message.rows !== witness.requested.rows)) {
            witness.requested = { cols: message.cols, rows: message.rows };
            witness.parsed = null;
          }
        }
      }
      send.call(this, data);
    };
    document.addEventListener("ovis:test-terminal-frame", (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const frame: Frame = event.detail;
      if (frame.pane === pane && frame.cols === witness.requested?.cols && frame.rows === witness.requested.rows) witness.parsed = frame;
    });
  }, pane);
  let after = 0;
  return async (timeout: number, allowReplay = false): Promise<Grid> => {
    const ready = await page.waitForFunction(({ after, allowReplay }) => {
      const witness = window.terminalGridWitness;
      if (!witness || witness.attach <= after || !witness.parsed || (!allowReplay && witness.parsed.replay)) return null;
      const { cols, rows } = witness.parsed;
      return { attach: witness.attach, grid: { cols, rows } };
    }, { after, allowReplay }, { timeout });
    try {
      const receipt = await ready.jsonValue();
      if (!receipt) throw new Error(`pane ${pane} did not parse a complete frame at the requested grid`);
      after = receipt.attach;
      return receipt.grid;
    } finally {
      await ready.dispose();
    }
  };
}
