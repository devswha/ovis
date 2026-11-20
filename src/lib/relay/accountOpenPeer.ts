import type { RelaySocket } from "../../../shared/relay-channel.ts";
import { generateKeyPair, openDaemonSecureChannel, type Transport } from "../../../shared/relay-e2ee.ts";
import { decodeFrame, encodeFrame, FrameType, LIMITS_V1, RELAY_PROTOCOL, type MuxFrame } from "../../../shared/relay-mux.ts";

export function accountOpenPeer(identity: ReturnType<typeof generateKeyPair>, peer: {
  readonly features: readonly string[];
  readonly provisional?: boolean;
  readonly auth: (frame: Extract<MuxFrame, { type: typeof FrameType.AUTH }>) => Uint8Array;
}): RelaySocket {
  const nonce = Buffer.alloc(32, 7).toString("base64url");
  const welcome = (features: readonly string[], provisional = false) => encodeFrame({
    type: FrameType.WELCOME, stream_id: 0, flags: 0, payload: {
      protocol: "ovis-mux", version: 1, limits: LIMITS_V1, nonce, features,
      server_version: "1.0.0", relay_protocol: RELAY_PROTOCOL, min_supported_client: "0.0.0",
      ...(provisional ? { provisional: true } : {}),
    },
  });
  let closed = false;
  const deliver = (data: string | ArrayBuffer): void => {
    if (!closed) socket.onmessage?.(new MessageEvent("message", { data }));
  };
  const daemon: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: deliver, close: (code, reason) => socket.close(code, reason),
  };
  const socket: RelaySocket = {
    binaryType: "arraybuffer", get readyState() { return closed ? 3 : 1; },
    onmessage: null, onclose: null, onerror: null,
    send(data) { if (!closed) daemon.onmessage?.({ data, isBinary: typeof data !== "string" }); },
    close(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      daemon.onclose?.(code, reason);
      socket.onclose?.(new CloseEvent("close", { code, reason }));
    },
  };
  const opening = openDaemonSecureChannel(daemon, {
    daemonKeyPair: identity,
    events: { onmessage: (data) => {
      if (!(data instanceof ArrayBuffer)) throw new TypeError("Expected mux bytes");
      const frame = decodeFrame(new Uint8Array(data));
      let reply: Uint8Array;
      switch (frame.type) {
        case FrameType.HELLO:
          if (frame.payload.required_features.some((feature) => !peer.features.includes(feature))) {
            reply = encodeFrame({ type: FrameType.SESSION_ERROR, stream_id: 0, flags: 0, payload: { code: "unsupported_extension", message: "" } });
          } else {
            if (peer.provisional && peer.features.length === 0) return;
            reply = welcome(peer.features);
          }
          break;
        case FrameType.AUTH: reply = peer.auth(frame); break;
        default: return;
      }
      void opening.then((secure) => secure.send(reply.slice().buffer)).catch(() => socket.close());
    } },
  });
  void opening.then((secure) => peer.provisional ? secure.send(welcome([], true).slice().buffer) : undefined).catch(() => socket.close());
  queueMicrotask(() => deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) })));
  return socket;
}
