import type { Page } from "playwright-core";
import { screenGrid, SYNC_END, SYNC_START } from "../server/core/terminal-process.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

type Grid = { readonly cols: number; readonly rows: number };
type Flow = NonNullable<Extract<ServerMessage, { type: "pty-data" }>["flow"]>;

/** Wait for a whole screen at the driving attach's grid, acknowledged by xterm after parsing. */
export function terminalGrid(page: Page, pane: string) {
  let requested: Grid | null = null;
  let pending: Flow | undefined;
  let buffer = "";
  let stream: string | undefined;
  let waiter: { live: boolean; accept: (grid: Grid) => void } | undefined;
  page.on("websocket", socket => {
    socket.on("framesent", ({ payload }) => {
      if (!waiter) return;
      const message: ClientMessage = JSON.parse(String(payload));
      if (!("pane_id" in message) || message.pane_id !== pane) return;
      if ((message.type === "attach" && !message.keep_size) ||
        (message.type === "resize" && requested && (message.cols !== requested.cols || message.rows !== requested.rows))) {
        requested = { cols: message.cols, rows: message.rows };
        buffer = "";
        pending = undefined;
      } else if (message.type === "pty-ack" && requested && pending?.stream_id === message.stream_id && pending.offset <= message.offset) {
        waiter.accept(requested);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      if (!waiter || !requested) return;
      const message: ServerMessage = JSON.parse(String(payload));
      if (message.type !== "pty-data" || message.pane_id !== pane || !message.flow || (waiter.live && message.replay)) return;
      if (stream !== message.flow.stream_id) {
        stream = message.flow.stream_id;
        buffer = "";
        pending = undefined;
      }
      buffer += message.data;
      for (;;) {
        const start = buffer.indexOf(SYNC_START);
        if (start < 0) {
          buffer = buffer.slice(1 - SYNC_START.length);
          return;
        }
        const end = buffer.indexOf(SYNC_END, start + SYNC_START.length);
        if (end < 0) {
          buffer = buffer.slice(start);
          return;
        }
        const grid = screenGrid(buffer.slice(start + SYNC_START.length, end));
        if (grid) pending = grid.cols === requested.cols && grid.rows === requested.rows ? message.flow : undefined;
        buffer = buffer.slice(end + SYNC_END.length);
      }
    });
  });
  return async (timeout: number, live = false): Promise<Grid> => {
    const committed = Promise.withResolvers<Grid>();
    requested = null;
    pending = undefined;
    buffer = "";
    const timer = setTimeout(() => committed.reject(new Error(`pane ${pane} did not parse a whole ${requested?.cols}x${requested?.rows} screen after attach`)), timeout);
    waiter = { live, accept: committed.resolve };
    try {
      return await committed.promise;
    } finally {
      clearTimeout(timer);
      waiter = undefined;
    }
  };
}
