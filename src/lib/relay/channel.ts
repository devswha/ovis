import { openClientSecureChannel } from "../../../shared/relay-e2ee.ts";
import type { SecureChannel, Transport } from "../../../shared/relay-e2ee.ts";
import { decodeFrame, FrameType, LIMITS_V1, MuxProtocolError } from "../../../shared/relay-mux.ts";
import { MuxEngine } from "../../../shared/relay-mux-engine.ts";
import type { SessionFrame } from "../../../shared/relay-mux-engine.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { getDevice, indexedDeviceStore, sign } from "./device.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";

export interface RelaySocket {
  binaryType: BinaryType;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}
export interface RelayChannelOptions {
  readonly store?: RelayDeviceStore;
  readonly socket?: (url: string) => RelaySocket;
  readonly label?: string;
  readonly signal?: AbortSignal;
  readonly onClose?: (error: Error) => void;
}
export interface RelayChannel {
  readonly mux: MuxEngine;
  readonly device: RelayDevice;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly role: "drive" | "watch";
  close(): void;
}

/** Resolves only after protected Noise, WELCOME and device admission all succeeded. Never retries. */
export async function openRelayChannel(offer: RelayOffer, options: RelayChannelOptions = {}): Promise<RelayChannel> {
  options.signal?.throwIfAborted();
  const store = options.store ?? indexedDeviceStore;
  const device = await getDevice(offer, store, options.label);
  options.signal?.throwIfAborted();
  const socket = (options.socket ?? ((url) => new WebSocket(url)))(
    `${offer.relay}/v1/ws?server_id=${offer.server_id}&role=client&v=1`,
  );
  socket.binaryType = "arraybuffer";
  return new Promise<RelayChannel>((resolve, reject) => {
    let phase: "assigned" | "handshake" | "welcome" | "auth" | "ready" | "closed" = "assigned";
    let secure: SecureChannel | undefined;
    let mux: MuxEngine | undefined;
    let connectionId = "";
    const limits = { ...LIMITS_V1 };
    let welcome: Uint8Array | undefined;
    let receipt: Uint8Array | undefined;
    let incoming = Promise.resolve();
    const stop = (error: Error): void => {
      if (phase === "closed") return;
      const admitted = phase === "ready";
      phase = "closed";
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", aborted);
      mux?.carrierLost();
      secure?.close(4000, "relay channel closed");
      socket.close(4000, "relay channel closed");
      if (admitted) options.onClose?.(error);
      else reject(error);
    };
    const aborted = (): void => stop(new DOMException("Relay connection aborted", "AbortError"));
    const deadline = setTimeout(() => stop(new MuxProtocolError("timeout", "Relay setup timed out")), 10_000);
    options.signal?.addEventListener("abort", aborted, { once: true });
    const transport: Transport = {
      send: (data) => socket.send(data),
      close: (code = 4000, reason = "") => socket.close(code, reason),
      onmessage: null, onclose: null, onerror: null,
    };
    const send = (frame: SessionFrame): Promise<void> => {
      if (!mux || phase === "closed") throw new MuxProtocolError("protocol_error", "Relay channel is closed");
      mux.sendSession(frame);
      return mux.flush();
    };
    const receive = async (data: string | ArrayBuffer): Promise<void> => {
      if (phase === "closed") return;
      if (typeof data === "string") throw new MuxProtocolError("protocol_error", "Expected binary mux frame");
      const bytes = new Uint8Array(data);
      if (phase === "ready") { mux?.receive(bytes); return; }
      const frame = decodeFrame(bytes);
      if (frame.type === FrameType.SESSION_ERROR) throw new MuxProtocolError(frame.payload.code, frame.payload.message);
      if (frame.type === FrameType.RECEIVED) {
        if (!mux || frame.payload > mux.stats.submitted) throw new MuxProtocolError("protocol_error", "Receipt exceeds submitted frames");
        receipt = bytes;
        return;
      }
      if (phase === "welcome" && frame.type === FrameType.WELCOME) {
        if (frame.payload.features.length) throw new MuxProtocolError("unsupported_extension", "Server selected unoffered features");
        phase = "auth";
        Object.assign(limits, frame.payload.limits);
        welcome = bytes;
        if (offer.code !== undefined) {
          await send({ type: FrameType.PAIR, flags: 0, stream_id: 0,
            payload: { code: offer.code, label: device.label, public_key: device.public_spki } });
        } else {
          if (device.device_id === null) throw new MuxProtocolError("auth_failed", "Pair this device first");
          const nonce = Uint8Array.from(atob(frame.payload.nonce.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
          const signature = await sign(device, nonce, offer.server_id);
          await send({ type: FrameType.AUTH, flags: 0, stream_id: 0,
            payload: { scheme: "device-key", device_id: device.device_id, signature } });
        }
        return;
      }
      if (phase !== "auth" || frame.type !== FrameType.AUTH_OK) {
        throw new MuxProtocolError("protocol_error", "Unexpected frame before AUTH_OK");
      }
      if (offer.code === undefined && frame.payload.device_id !== device.device_id) {
        throw new MuxProtocolError("auth_failed", "AUTH_OK named a different device");
      }
      const admitted = await store.update(offer.server_id, (current) => {
        if (!current || current.server_public_key !== device.server_public_key || current.public_spki !== device.public_spki) {
          throw new MuxProtocolError("auth_changed", "Stored relay identity changed during authentication");
        }
        return { ...current, device_id: frame.payload.device_id };
      });
      if (options.signal?.aborted || !secure?.isOpen() || !mux || !welcome) return;
      // Defer setup accounting until admission: receive() automatically emits RECEIVED.
      // Outgoing HELLO/AUTH already used the mux ledger, so inbound receipts are safe.
      mux.receive(welcome);
      mux.receive(bytes);
      if (receipt) mux.receive(receipt);
      mux.authenticate(admitted.device_id ?? frame.payload.device_id);
      phase = "ready";
      clearTimeout(deadline);
      resolve({ mux, device: admitted, connectionId, sessionId: frame.payload.session_id, role: frame.payload.role,
        close: () => stop(new MuxProtocolError("internal_error", "Relay channel closed")) });
    };
    const failed = (error: unknown): void => stop(error instanceof Error ? error : new Error(String(error)));
    socket.onclose = (event) => {
      transport.onclose?.(event.code, event.reason);
      stop(new MuxProtocolError("internal_error", "Relay socket closed"));
    };
    socket.onerror = () => {
      const error = new MuxProtocolError("internal_error", "Relay socket failed");
      transport.onerror?.(error);
      stop(error);
    };
    socket.onmessage = (event) => {
      if (phase === "closed") return;
      if (phase !== "assigned") {
        if (typeof event.data !== "string" && !(event.data instanceof ArrayBuffer)) {
          stop(new MuxProtocolError("protocol_error", "Invalid relay carrier frame"));
          return;
        }
        transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
        return;
      }
      phase = "handshake";
      incoming = incoming.then(async () => {
        if (options.signal?.aborted) return;
        const assigned: unknown = typeof event.data === "string" ? JSON.parse(event.data) : null;
        if (!assigned || typeof assigned !== "object" || !("type" in assigned) || assigned.type !== "assigned"
          || !("connection_id" in assigned) || typeof assigned.connection_id !== "string"
          || !/^[0-9a-f]{32}$/.test(assigned.connection_id)) {
          throw new MuxProtocolError("protocol_error", "Invalid relay assignment");
        }
        connectionId = assigned.connection_id;
        phase = "welcome";
        const opened = Promise.withResolvers<void>();
        secure = await openClientSecureChannel(transport, {
          daemonPublicKeyB64: offer.server_public_key, minimumMode: "protected",
          events: {
            onopen: () => opened.resolve(),
            onmessage: (data) => { incoming = incoming.then(() => receive(data)).catch(failed); },
            onerror: (error) => { opened.reject(error); stop(error); },
            onclose: () => { const error = new MuxProtocolError("internal_error", "Secure relay channel closed"); opened.reject(error); stop(error); },
          },
        });
        await opened.promise;
        if (!secure.isOpen()) return;
        const carrier = secure;
        mux = new MuxEngine({
          role: "client", send: (bytes) => carrier.send(bytes.slice().buffer),
          close: () => stop(new MuxProtocolError("internal_error", "Relay mux closed")),
          clock: { now: () => performance.now(), setTimeout: (callback, ms) => {
            const timer = setTimeout(() => {
              if (phase === "ready") callback();
              else stop(new MuxProtocolError("timeout", "Relay setup timed out"));
            }, ms);
            return () => clearTimeout(timer);
          } },
          outboundWireByteLength: (bytes) => carrier.outboundWireByteLength(bytes.slice().buffer),
          routingOverhead: 0, maxWireMessageBytes: 65536, limits,
          onClose: (error) => stop(error),
        });
        await send({ type: FrameType.HELLO, flags: 0, stream_id: 0,
          payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } });
      }).catch(failed);
    };
  });
}
