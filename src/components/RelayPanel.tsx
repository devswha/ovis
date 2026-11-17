import { useEffect, useRef, useState } from "react";
import { Keyboard, Link2, RefreshCw } from "lucide-react";

import "./RelayPanel.css";

import { copyText } from "../lib/clipboard.ts";
import { ApiError, cancelRelayCode, endPairing, requestRelayCode, requestRelayLink, requestRelayOffer, startPairing, type RelayCode, type RelayOffer } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { callNative, hasNativePlugin } from "../lib/nativeApp.ts";
import { announcePairingCode, PAIRING_CODE_EVENT, QR_CODE_ENDED_CHANNEL, tellOtherWindowsQrCodeEnded, type AnnouncedCode, type RelayState } from "../lib/useRelay.ts";
import type { PairingCode, RelayStatus } from "../../shared/protocol.ts";
import { isTailnetCarrier } from "../../shared/relay-mux.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { QrReveal, ShareLink } from "./PhonePanel.tsx";
import { KeyId } from "./KeyId.tsx";
import { QrCode } from "./QrCode.tsx";
import { CompactPair } from "./CompactPair.tsx";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";

export const failureText = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

export function statusText(t: ReturnType<typeof useT>, status: RelayStatus): string {
  if (status.blocked === "serve_only") return t("Blocked: OVIS_TAILSCALE_SERVE_ONLY says tailscale serve is the only way in. Unset it on this PC and restart the app.");
  if (status.blocked === "identity_unreadable") return t("Blocked: this PC's relay identity cannot be read. Reset it under More settings in Devices and PCs to use the relay again.");
  const pass = status.pass;
  if (pass?.refused && status.phase === "error" && pass.state !== "ok") return pass.state === "not_listed"
    ? t("Add this PC to your Ovis account to use the Ovis relay, or connect over the same Wi-Fi or Tailscale.")
    : pass.state === "limit"
    ? t("This account has as many PCs on the Ovis relay as it may. Remove one from your account to add this one.")
    : pass.state === "unavailable"
      ? t("Cannot reach the Ovis account service for a relay pass. Retrying.")
      : t("The Ovis relay needs an Ovis account. Sign in, or connect over the same Wi-Fi or Tailscale.");
  if (pass && status.phase === "online" && pass.state !== "ok" && pass.relay !== null && pass.relay !== "ok" && pass.enforce_at !== null) {
    return t("Online. Sign in to keep using the Ovis relay after {date}. Same Wi-Fi, Tailscale and your own relay keep working without an account.", { date: new Date(pass.enforce_at).toLocaleDateString() });
  }
  switch (status.phase) {
    case "off": return t("Off. Nothing goes through the relay.");
    case "connecting": return t("Connecting…");
    case "online":
      return status.sessions === 0 ? t("Online. No phone connected.") : status.sessions === 1 ? t("Online. 1 phone connected.") : t("Online. {n} phones connected.", { n: status.sessions });
    default: return t("Error: {message}", { message: status.error ?? t("Could not reach the relay.") });
  }
}

export async function openOwnOffer(url: string): Promise<void> {
  if (hasNativePlugin("HerdrShell")) {
    const offer = decodeOffer(url);
    if (offer === null) throw new Error("The relay's offer carries no pairing.");
    const scope = url.slice(0, url.indexOf("#"));
    await callNative("HerdrShell", "open", { url, scope, ...(offer.name === undefined ? {} : { name: offer.name }) });
    return;
  }
  window.location.assign(url);
}

export function RelayDirectRow({ relay, readOnly }: { relay: RelayState; readOnly: boolean }) {
  const t = useT();
  const [failure, setFailure] = useState<string | null>(null);
  const direct = relay.status?.direct;
  if (direct === undefined || relay.status?.phase === "off") return null;
  const change = (on: boolean) => {
    setFailure(null);
    relay.request({ direct: on }).catch((reason: unknown) => setFailure(failureText(reason)));
  };
  return (
    <SettingsRow label={direct.on ? t("Same Wi-Fi direct connection on") : t("Same Wi-Fi direct connection off")} description={<>
      {!direct.on ? t("Phones paired through the relay always go through the relay.")
        : direct.carriers.length > 0 ? (!direct.carriers.some(isTailnetCarrier) ? t("This PC takes connections on your home network. Only devices paired through the relay can sign in there; nothing new pairs.")
          : direct.carriers.every(isTailnetCarrier) ? t("This PC takes connections on Tailscale. Only devices paired through the relay can sign in there; nothing new pairs.")
          : t("This PC takes connections on your home network and on Tailscale. Only devices paired through the relay can sign in there; nothing new pairs."))
        : t("On, but this PC has no home network address to listen on right now.")}
      {failure !== null && <span className="settings-hint relay-error" role="alert">{failure}</span>}
    </>}>
      {!readOnly && <Toggle label={t("Same Wi-Fi direct connection")} checked={direct.on} disabled={relay.pending} onChange={change} />}
    </SettingsRow>
  );
}

let relayAnnouncing = false;
function announceFromRelay(code: AnnouncedCode): void {
  relayAnnouncing = true;
  try { announcePairingCode(code); } finally { relayAnnouncing = false; }
}

export function RelayPairing({ phone = false, compact = false, qrOnly = false, onInAccount }: { phone?: boolean; compact?: boolean; qrOnly?: boolean; onInAccount?: () => void }) {
  const t = useT();
  const [offer, setOffer] = useState<RelayOffer | null>(null);
  const [left, setLeft] = useState("");
  const [state, setState] = useState<"minting" | "live" | "expired" | "failed">("minting");
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const announcing = useRef(false);
  const shown = useRef<string | null>(null);
  const quiet = useRef(false);
  const heard = useRef<string | null>(null);
  const again = () => setGeneration((value) => value + 1);
  const refused = useRef(onInAccount);
  refused.current = onInAccount;
  const [typedReset, setTypedReset] = useState(0);
  const [typedId, setTypedId] = useState<string | null>(null);
  const dropTyped = () => setTypedReset((value) => value + 1);

  useEffect(() => {
    if (compact && !qrOnly && generation === 0) return;
    let cancelled = false;
    const silent = quiet.current;
    quiet.current = false;
    setState("minting");
    requestRelayOffer({ noAccountOnly: qrOnly }).then((next) => {
      if (cancelled) return;
      setOffer(next);
      setState("live");
      const code = decodeOffer(next.url)?.code;
      const differs = qrOnly && code !== heard.current;
      shown.current = code ?? null;
      if (code !== undefined && (!silent || differs)) {
        announcing.current = true;
        try { announceFromRelay({ code, expires_at: next.expires_at, ...(qrOnly ? { qrOnly: true } : {}) }); } finally { announcing.current = false; }
      }
    }, (reason: unknown) => {
      if (cancelled) return;
      setOffer(null);
      if (reason instanceof ApiError && reason.code === "in_account" && refused.current !== undefined) {
        refused.current();
        return;
      }
      setFailure(failureText(reason));
      setState("failed");
    });
    return () => { cancelled = true; };
  }, [generation]);

  useEffect(() => {
    if (!qrOnly || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(QR_CODE_ENDED_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== shown.current) return;
      shown.current = null;
      setOffer(null);
      again();
    };
    return () => channel.close();
  }, [qrOnly]);

  useEffect(() => {
    const onCode = (event: Event) => {
      if (announcing.current) return;
      dropTyped();
      const code = (event as CustomEvent<PairingCode | undefined>).detail?.code;
      if (relayAnnouncing) {
        heard.current = code ?? null;
        if (code === undefined || code !== shown.current) { quiet.current = true; again(); }
        return;
      }
      again();
    };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

  useEffect(() => {
    if (offer === null) return;
    let wasLive = false;
    const tick = () => {
      const ms = Date.parse(offer.expires_at) - Date.now();
      if (ms <= 0) {
        setOffer(null);
        if (wasLive) { if (!compact || qrOnly) again(); } else setState("expired");
        return;
      }
      wasLive = true;
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [offer]);

  const renew = async () => {
    setState("minting");
    dropTyped();
    if (qrOnly) {
      try {
        const ended = shown.current;
        if (ended !== null && (await endPairing(ended)).cancelled) tellOtherWindowsQrCodeEnded(ended);
        again();
      } catch (reason) {
        setOffer(null);
        setFailure(t("The old code could not be ended, so it may still work until it runs out: {message} New code tries again.", { message: failureText(reason) }));
        setState("failed");
      }
      return;
    }
    try {
      const code = await startPairing();
      announcing.current = true;
      try { announceFromRelay(code); } finally { announcing.current = false; }
      again();
    } catch (reason) {
      setOffer(null);
      setFailure(failureText(reason));
      setState("failed");
    }
  };

  if (qrOnly) return (
    <div className="relay-pairing-compact relay-pairing-qr-only" role="status">
      <div className="compact-pair">
        {offer !== null ? <QrCode value={offer.url} label={t("QR code that pairs a phone through the relay")} size={132} /> : <div className="compact-pair-qr-empty" role="status">{state === "minting" ? t("Getting a code…") : ""}</div>}
        <div className="compact-pair-side">
          <p className="settings-description">
            {state === "live" && t("Expires in {time}.", { time: left })}
            {state === "expired" && t("This code expired.")}
          </p>
          <div className="compact-pair-actions">
            <button type="button" className="btn" disabled={state === "minting"} aria-busy={state === "minting" || undefined} onClick={() => void renew()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
          </div>
        </div>
      </div>
      {state === "failed" && failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
    </div>
  );
  if (compact) return <CompactRelay qr={offer?.url ?? null} qrExpires={offer?.expires_at ?? null} failure={state === "failed" ? failure : null} reset={typedReset} onMinted={again} />;
  const countdown = (
    <>
      {state === "live" && t("Expires in {time}.", { time: left })}
      {state === "expired" && t("This code expired.")}
      {state === "minting" && t("Getting a code…")}
    </>
  );
  const offerId = offer === null ? undefined : decodeOffer(offer.url)?.server_id;
  const serverId = offerId ?? typedId;
  const pcId = serverId !== null && (
    <div className="relay-pairing-id">
      <p className="settings-description">{t("This PC's ID")}</p>
      <KeyId id={serverId} label={t("This PC's ID")} />
    </div>
  );
  const newCode = <button type="button" className="btn" disabled={state === "minting"} onClick={() => void renew()}><RefreshCw aria-hidden="true" />{t("New code")}</button>;
  if (phone) return (
    <div className="relay-pairing-phone" role="status">
      <p className="settings-label">{t("Connect another device")}</p>
      <p className="settings-description">{t("Send it this link, or show it the QR code. It opens Ovis there and pairs it with this PC.")} {countdown}</p>
      {state === "failed" && failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
      {offer !== null && <ShareLink url={offer.url} copyLabel={t("Copy link")}>{newCode}</ShareLink>}
      {offer === null && <div className="phone-actions">{newCode}</div>}
      {offer !== null && <QrReveal value={offer.url} label={t("QR code that pairs a phone through the relay")} hint={t("Scan it with the other device's camera.")} />}
      <TypedCode reset={typedReset} onMinted={(minted) => { setTypedId(minted.server_id); again(); }} />
      {pcId}
    </div>
  );
  return (
    <div className="settings-item relay-pairing" role="status">
      {offer !== null && <QrCode value={offer.url} label={t("QR code that pairs a phone through the relay")} />}
      <div className="relay-pairing-text">
        <p className="settings-label">{t("Scan it with the phone's camera")}</p>
        <p className="settings-description">
          {t("It opens Ovis on the phone and pairs it with this PC.")}{" "}
          {state === "live" && t("Expires in {time}.", { time: left })}
          {state === "expired" && t("This code expired.")}
          {state === "minting" && t("Getting a code…")}
        </p>
        {state === "failed" && failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
        <div className="phone-actions">
          <button type="button" className="btn" disabled={state === "minting"} onClick={() => void renew()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
        </div>
        <CodelessLink />
        <TypedCode reset={typedReset} onMinted={(minted) => { setTypedId(minted.server_id); again(); }} />
        {pcId}
      </div>
    </div>
  );
}

function CompactRelay({ qr, qrExpires, failure, reset, onMinted }: { qr: string | null; qrExpires: string | null; failure: string | null; reset: number; onMinted: () => void }) {
  const t = useT();
  const [code, setCode] = useState<RelayCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const mint = async () => {
    const mine = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const minted = await requestRelayCode();
      if (mine !== request.current) return;
      setCode(minted);
    } catch (reason) {
      if (mine === request.current) { setCode(null); setError(failureText(reason)); }
    } finally {
      if (mine === request.current) {
        setBusy(false);
        onMinted();
      }
    }
  };
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void mint();
  });
  const lastReset = useRef(reset);
  useEffect(() => {
    if (lastReset.current === reset) return;
    lastReset.current = reset;
    request.current++;
    setCode(null);
    setBusy(false);
  }, [reset]);
  const deadline = code !== null ? code.expires_at : qrExpires;
  useEffect(() => {
    if (deadline === null) return;
    const ms = Date.parse(deadline) - Date.now();
    if (ms <= 0) {
      if (code !== null) { setCode(null); setError(t("This code expired.")); }
      return;
    }
    const timer = window.setTimeout(() => void mint(), ms);
    return () => window.clearTimeout(timer);
  }, [code, deadline]);
  return (
    <div className="relay-pairing-compact" role="status">
      <CompactPair qr={qr} qrLabel={t("QR code that pairs a phone through the relay")} code={code?.code ?? null} codeLabel={t("Code to type")} busy={busy} onRefresh={() => void mint()} />
      {(error ?? failure) !== null && <p className="settings-hint relay-error" role="alert">{error ?? failure}</p>}
    </div>
  );
}

function TypedCode({ reset, onMinted }: { reset: number; onMinted: (code: RelayCode) => void }) {
  const t = useT();
  const [code, setCode] = useState<RelayCode | null>(null);
  const request = useRef(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { request.current++; setCode(null); }, [reset]);
  const [failure, setFailure] = useState<string | null>(null);
  const [left, setLeft] = useState("");
  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const ms = Date.parse(code.expires_at) - Date.now();
      if (ms <= 0) { setCode(null); return; }
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);
  const show = async () => {
    const mine = ++request.current;
    setFailure(null);
    setBusy(true);
    try {
      const minted = await requestRelayCode();
      if (mine !== request.current) return;
      setCode(minted);
      onMinted(minted);
    } catch (reason) {
      if (mine !== request.current) return;
      setCode(null);
      setFailure(failureText(reason));
    } finally { setBusy(false); }
  };
  const hide = async () => {
    const mine = ++request.current;
    setFailure(null);
    setBusy(true);
    try {
      await cancelRelayCode();
      if (mine === request.current) setCode(null);
    } catch (reason) {
      if (mine === request.current) setFailure(failureText(reason));
    } finally { setBusy(false); }
  };
  return (
    <>
      <div className="phone-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void show()}><Keyboard aria-hidden="true" />{code === null ? t("Show a code to type") : t("New code to type")}</button>
        {code !== null && <button type="button" className="btn" disabled={busy} onClick={() => void hide()}>{t("Hide the code")}</button>}
      </div>
      {code !== null && (
        <div className="relay-typed-code" role="status">
          <p className="relay-typed-code-value" aria-label={t("Code to type")}>{code.code}</p>
          <p className="settings-hint">{t("On the other device, open app.ovis.sh, choose Pair with a code and type it. Expires in {time}. It works once.", { time: left })}</p>
          <p className="settings-hint">{t("That device then shows an ID: pair only if it matches this PC's ID below, every group.")}</p>
        </div>
      )}
      {failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
    </>
  );
}

function CodelessLink() {
  const t = useT();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [link, setLink] = useState<{ url: string; select: boolean } | null>(null);
  const linkRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (link?.select && linkRef.current) window.getSelection()?.selectAllChildren(linkRef.current);
  }, [link]);
  const copy = async () => {
    const initiator = document.activeElement;
    try {
      const { url } = await requestRelayLink();
      if (await copyText(url)) { setLink(null); setNote({ ok: true, text: t("Copied. Open it on the phone within 10 minutes: both screens show six digits to compare, and you approve the phone here.") }); }
      else { setLink({ url, select: document.activeElement === initiator }); setNote(null); }
    } catch (reason) { setNote({ ok: false, text: failureText(reason) }); }
  };
  return (
    <>
      <div className="phone-actions">
        <button type="button" className="btn" onClick={() => void copy()}><Link2 aria-hidden="true" />{t("Copy a link without a code")}</button>
      </div>
      {link !== null && <code className="settings-hint relay-codeless-link" ref={linkRef}>{link.url}</code>}
      {note !== null && <p className={note.ok ? "settings-hint" : "settings-hint relay-error"} role={note.ok ? "status" : "alert"}>{note.text}</p>}
    </>
  );
}
