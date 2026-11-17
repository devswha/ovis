import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingCode, RelayStatus } from "../../shared/protocol.ts";
import { ApiError, fetchRelay, requestRelay, requestRelayDirect } from "./api.ts";
import { usePageVisible } from "./visibility.ts";

export function inRelayShell(): boolean {
  return typeof document !== "undefined" && document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") === "relay";
}

export const PAIRING_CODE_EVENT = "ovis:pairing-code";

export interface AnnouncedCode extends PairingCode {
  readonly qrOnly?: true;
}

export function announcePairingCode(code: AnnouncedCode): void {
  window.dispatchEvent(new CustomEvent<AnnouncedCode>(PAIRING_CODE_EVENT, { detail: code }));
}

export const QR_CODE_ENDED_CHANNEL = "ovis:qr-code-ended";

export function announceQrCodeEnded(code: string): void {
  announcePairingCode({ code, expires_at: new Date(0).toISOString(), qrOnly: true });
  tellOtherWindowsQrCodeEnded(code);
}

export function tellOtherWindowsQrCodeEnded(code: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(QR_CODE_ENDED_CHANNEL);
  channel.postMessage(code);
  channel.close();
}

export const DEVICES_CHANGED_EVENT = "ovis:devices-changed";

function pollDelay(status: RelayStatus): number {
  if (status.phase === "connecting") return 1_500;
  if (status.phase === "error" && status.blocked === null) return 5_000;
  return 15_000;
}

export function useRelay() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible || unsupported) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      let delay = 15_000;
      try {
        const next = await fetchRelay();
        if (stopped) return;
        setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        delay = pollDelay(next);
      } catch (error) {
        if (!stopped && error instanceof ApiError && error.status === 404) { setUnsupported(true); return; }
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, visible, unsupported]);

  const request = useCallback(async (action: "start" | "stop" | "reset-identity" | { direct: boolean }): Promise<RelayStatus> => {
    setPending(true);
    try {
      const next = typeof action === "string" ? await requestRelay(action) : await requestRelayDirect(action.direct);
      if (mounted.current) {
        setStatus(next);
        setRefresh((value) => value + 1);
      }
      return next;
    } finally { if (mounted.current) setPending(false); }
  }, []);
  return { status, unsupported, pending, request };
}

export type RelayState = ReturnType<typeof useRelay>;
