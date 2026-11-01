import type { WebSocketRoute } from "playwright-core";

/**
 * The shell's wss: origin carried to a test relay, shared by shell and media browser QA. `frame` is
 * told of each frame the relay sends the page, `sent` of each the page sends the relay.
 */
export function relayBrowserSocket(ws: WebSocketRoute, address: () => string, frame: () => void = () => {}, release?: Promise<void>, sent: () => void = () => {}): void {
  const queue: (string | Buffer)[] = [];
  let upstream: WebSocket | null = null;
  let closed = false;
  ws.onMessage((message) => {
    sent();
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(message); else queue.push(message);
  });
  ws.onClose(() => { closed = true; upstream?.close(); });
  const start = (): void => {
    if (closed) return;
    const socket = new WebSocket(address());
    socket.binaryType = "arraybuffer";
    upstream = socket;
    socket.onopen = () => { for (const message of queue.splice(0)) socket.send(message); };
    socket.onmessage = (event) => {
      frame();
      ws.send(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer));
    };
    socket.onerror = () => { /* The close event carries the browser's network failure. */ };
    socket.onclose = (event) => {
      if (closed) return;
      const code = [1005, 1006, 1015].includes(event.code) ? 1011 : event.code;
      ws.close({ code, reason: event.reason || "relay connection lost" });
    };
  };
  if (release) void release.then(start); else start();
}
