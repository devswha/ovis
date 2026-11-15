/**
 * What a page of a test browser can reach that is not its world (proof-signin.ts, proof-devices.ts): WebSockets to
 * hosts outside the world and WebRTC's UDP (STUN), checked at the far end. This process listens on the addresses it is
 * given (this PC's loopback, its address on a world's network) for WebSocket connections and UDP packets, and a page
 * then tries both; whatever arrives is counted.
 */
import type { Page } from "playwright-core";

export interface LeakTargets {
  /** where the page is sent: ws://<address>:<port>/ and stun:<address>:<port> per address */
  readonly ws: readonly string[];
  readonly stun: readonly string[];
  /** a plain page on the first address, for a browser with no world (the case that shows the check can tell) */
  readonly page: string;
  connections(): number;
  packets(): number;
  close(): void;
}

export async function leakTargets(addresses: readonly string[]): Promise<LeakTargets> {
  let connections = 0;
  let packets = 0;
  const servers = addresses.map((hostname) => Bun.serve({ hostname, port: 0,
    fetch: (request, server) => server.upgrade(request) ? undefined : new Response("<!doctype html><title>outside the world</title>", { headers: { "content-type": "text/html" } }),
    websocket: { open() { connections++; }, message() {} } }));
  const sockets = await Promise.all(addresses.map((hostname) => Bun.udpSocket({ hostname, port: 0, socket: { data() { packets++; } } })));
  return {
    ws: servers.map((server, index) => `ws://${addresses[index]}:${server.port}/`),
    stun: sockets.map((socket, index) => `stun:${addresses[index]}:${socket.port}`),
    page: `http://${addresses[0]}:${servers[0]!.port}/`,
    connections: () => connections, packets: () => packets,
    close: () => { for (const server of servers) server.stop(true); for (const socket of sockets) socket.close(); },
  };
}

/** What the page saw: each WebSocket's end (open, or refused) and every ICE candidate WebRTC gathered. */
export interface Seen { readonly ws: Readonly<Record<string, string>>; readonly candidates: readonly string[]; readonly rtc: string }

/** The page opens each WebSocket and gathers ICE candidates against the STUN servers, each bounded by 5 s. */
export async function probeLeaks(page: Page, ws: readonly string[], stun: readonly string[]): Promise<Seen> {
  return page.evaluate(async ([sockets, servers]) => {
    const opened = await Promise.all(sockets!.map((url) => new Promise<[string, string]>((resolve) => {
      let socket: WebSocket;
      try { socket = new WebSocket(url); } catch (error) { resolve([url, `refused: ${(error as Error).message}`]); return; }
      const timer = setTimeout(() => { socket.close(); resolve([url, "no answer in 5 s"]); }, 5000);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve([url, "OPEN"]); };
      socket.onerror = () => { clearTimeout(timer); resolve([url, "refused"]); };
      socket.onclose = (event) => { clearTimeout(timer); resolve([url, `closed ${event.code}`]); };
    })));
    const candidates: string[] = [];
    let connection: RTCPeerConnection;
    try { connection = new RTCPeerConnection({ iceServers: servers!.map((urls) => ({ urls })) }); } catch (error) {
      return { ws: Object.fromEntries(opened), candidates, rtc: `no RTCPeerConnection (${(error as Error).message.slice(0, 60)})` };
    }
    connection.createDataChannel("probe");
    const gathered = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      connection.onicecandidate = (event) => {
        if (event.candidate === null) { clearTimeout(timer); resolve(); return; }
        if (event.candidate.candidate !== "") candidates.push(event.candidate.candidate);
      };
    });
    await connection.setLocalDescription(await connection.createOffer());
    await gathered;
    connection.close();
    return { ws: Object.fromEntries(opened), candidates, rtc: "gathered" };
  }, [[...ws], [...stun]] as const);
}

/** Nothing left the world: no WebSocket opened anywhere, no candidate, and the far ends saw nothing. */
export function sealed(seen: Seen, targets: LeakTargets): boolean {
  return Object.values(seen.ws).every((end) => end !== "OPEN") && seen.candidates.length === 0 && targets.connections() === 0 && targets.packets() === 0;
}

export const describeSeen = (seen: Seen, targets: LeakTargets) =>
  `${Object.entries(seen.ws).map(([url, end]) => `${url} ${end}`).join("; ")}; WebRTC ${seen.rtc}, ICE candidates ${seen.candidates.length}${seen.candidates.length > 0 ? ` (${seen.candidates.map((line) => line.split(" ").slice(4, 8).join(" ")).join(", ").slice(0, 160)})` : ""}; at the far end: ${targets.connections()} WebSocket(s), ${targets.packets()} UDP packet(s)`;
