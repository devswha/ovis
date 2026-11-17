import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";

import "./DevicePairedNotice.css";
import "./RelayPairingPrompt.css";

import type { RelayPairingRequest } from "../../shared/protocol.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { inFocusTrap } from "../lib/useFocusTrap.ts";
import { failureText } from "./RelayPanel.tsx";

export function secondsLeft(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

const heard = new WeakMap<RelayPairingRequest, number>();
export function deadlineOf(pairing: RelayPairingRequest, now: number): number | null {
  const known = heard.get(pairing);
  if (known !== undefined) return known;
  const left = pairing.left_ms;
  const at = typeof left === "number" && Number.isFinite(left) && left >= 0 ? now + left : Date.parse(pairing.expires_at);
  if (Number.isNaN(at)) return null;
  heard.set(pairing, at);
  return at;
}

export function aroundDigits(template: string, name: string): [string, string] {
  const at = template.indexOf("{digits}");
  const named = (part: string) => part.replaceAll("{name}", () => name);
  return at < 0 ? [`${named(template)} `, ""] : [named(template.slice(0, at)), named(template.slice(at + "{digits}".length))];
}

const TEXT_ENTRY = 'input, textarea, select, iframe, embed, object, [contenteditable]:not([contenteditable="false"])';
export function takesFocus(active: Element | null): boolean {
  if (active === null || active === document.body) return true;
  if (!(active instanceof HTMLElement) || active.closest(TEXT_ENTRY) !== null) return false;
  return inFocusTrap(active);
}

export const APPROVE_KEY_GUARD_MS = 1000;
export const APPROVE_POINTER_GUARD_MS = 500;

/**
 * The longest a key or a click is taken to have been on its way to the page. An event's clock that runs
 * behind the page's (some browsers' does after a sleep) then makes Approve wait this much longer, not for good.
 */
export const INPUT_AGE_MAX_MS = 5000;

export function inputAge(timeStamp: unknown, now: number = performance.now()): number {
  if (typeof timeStamp !== "number" || !Number.isFinite(timeStamp) || timeStamp <= 0) return 0;
  return Math.min(INPUT_AGE_MAX_MS, Math.max(0, now - timeStamp));
}

export function RelayPairingPrompt({ pairings }: { pairings: readonly RelayPairingRequest[] }) {
  const t = useT();
  const id = useId();
  const [busy, setBusy] = useState<{ id: string; decision: "approve" | "decline" } | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const decide = async (id: string, decision: "approve" | "decline") => {
    setBusy({ id, decision });
    setFailure(null);
    try { await decideRelayPairing(id, decision); }
    catch (error) { setFailure({ id, text: failureText(error instanceof Error ? error : new Error(String(error))) }); }
    finally { setBusy(null); }
  };

  const ids = pairings.map((pairing) => pairing.id).join(" ");
  const [now, setNow] = useState(() => Date.now());
  const deadlines = pairings.map((pairing) => deadlineOf(pairing, Date.now()));
  const timed = deadlines.some((at) => at !== null);
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timed, ids]);

  const layer = useRef<HTMLDivElement>(null);
  const prompts = useRef(new Map<string, HTMLDivElement>());
  const since = useRef(new Map<string, number>());
  const entered = useRef(new Map<string, number>());
  const pressed = useRef<{ id: string; key: boolean; at: number } | null>(null);
  const places = useRef(new Map<string, number>());
  const held = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  /** the focus was given back by a cleanup React ran only to run the effects again (development's replay): it is taken again */
  const replayed = useRef(false);
  useLayoutEffect(() => {
    const arrived = pairings.filter((pairing) => !since.current.has(pairing.id));
    const at = Date.now();
    since.current = new Map(pairings.map((pairing, index) => [pairing.id, places.current.get(pairing.id) === index ? since.current.get(pairing.id) ?? at : at]));
    places.current = new Map(pairings.map((pairing, index) => [pairing.id, index]));
    const active = document.activeElement;
    if (replayed.current) { replayed.current = false; held.current = true; }
    if (layer.current?.contains(active)) return;
    if (!takesFocus(active)) return;
    const next = arrived[0] ?? (held.current ? pairings[0] : undefined);
    const node = next && prompts.current.get(next.id);
    if (!node) return;
    const before = held.current ? opener.current : active instanceof HTMLElement ? active : null;
    node.focus({ preventScroll: true });
    if (document.activeElement !== node) return;
    opener.current = before;
    held.current = true;
    since.current.set(next.id, at);
    const scrolled = layer.current?.scrollTop;
    node.scrollIntoView({ block: "nearest" });
    if (layer.current?.scrollTop !== scrolled) for (const moved of since.current.keys()) since.current.set(moved, at);
  }, [ids]);
  useLayoutEffect(() => {
    const node = layer.current;
    return () => {
      const active = document.activeElement;
      const from = opener.current;
      if (!held.current || !from?.isConnected) return;
      if (active !== null && active !== document.body && !node?.contains(active)) return;
      from.focus({ preventScroll: true });
      replayed.current = true;
    };
  }, []);
  /**
   * `click.detail`: 0 is Enter or Space on the button (a click that no pointer made), 2 the second click of a
   * double-click. The guards count to when the click was made, or the key or the press it comes of when that
   * was earlier (a click a key makes may be stamped only when the page gets to the key).
   */
  const approve = (id: string, click: { detail: number; timeStamp?: number }): void => {
    const key = click.detail === 0;
    const press = pressed.current;
    pressed.current = null;
    if (click.detail > 1) return;
    const arrived = since.current.get(id);
    if (arrived === undefined) return;
    const from = key ? Math.max(arrived, entered.current.get(id) ?? arrived) : arrived;
    const age = Math.max(inputAge(click.timeStamp), press !== null && press.id === id && press.key === key ? inputAge(press.at) : 0);
    if (Date.now() - age - from < (key ? APPROVE_KEY_GUARD_MS : APPROVE_POINTER_GUARD_MS)) return;
    void decide(id, "approve");
  };

  return (
    <div ref={layer} className="relay-pairing-layer" role="region" aria-live="assertive" aria-label={t("Devices waiting for approval")}
      onFocus={(event) => {
        const from = event.relatedTarget;
        if (!held.current && from instanceof HTMLElement && !event.currentTarget.contains(from) && inFocusTrap(from)) opener.current = from;
        held.current = true;
        for (const [entering, node] of prompts.current) {
          if (event.target instanceof Node && node.contains(event.target) && !(from instanceof Node && node.contains(from))) entered.current.set(entering, Date.now());
        }
      }}
      // to nothing (Approve pressed by a key is disabled, then gone: the browser drops the focus) is not the person moving on
      onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) held.current = false; }}>
      {pairings.map((pairing, index) => {
        const deciding = busy?.id === pairing.id ? busy.decision : null;
        const digits = <strong className="relay-pairing-digits">{`${pairing.digits.slice(0, 3)} ${pairing.digits.slice(3)}`}</strong>;
        const [before, after] = pairing.local_only
          ? aroundDigits(t("{name} wants to add this PC to your account. Type {digits} on {name}, or check that {name} shows the same number, then press Approve here."), pairing.label)
          : [`${t("{name} wants to pair through the relay. Approve it only if its screen shows", { name: pairing.label })} `, ""];
        const until = deadlines[index] ?? null;
        const left = until === null ? null : secondsLeft(until, Math.max(now, until - (pairing.left_ms ?? Infinity)));
        return (
          <div key={pairing.id} ref={(node) => { if (node) prompts.current.set(pairing.id, node); else prompts.current.delete(pairing.id); }}
            className="update-notice is-paired relay-pairing-prompt" role="group" aria-labelledby={`${id}-${pairing.id}`} tabIndex={-1}
            data-testid="relay-pairing-prompt" data-local-only={pairing.local_only ? "true" : undefined}>
            <Smartphone aria-hidden="true" />
            <span>
              <span id={`${id}-${pairing.id}`}>{before}{digits}{after}</span>
              {left !== null && <span className="relay-pairing-left" aria-live="off" data-testid="relay-pairing-left"> {t("{n} s left", { n: left })}</span>}
              {failure?.id === pairing.id && <span className="relay-error" role="alert"> {failure.text}</span>}
            </span>
            <div className="device-paired-actions">
              <button type="button" className="btn btn-primary" disabled={deciding !== null} aria-busy={deciding === "approve" ? true : undefined}
                onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !event.repeat) pressed.current = { id: pairing.id, key: true, at: event.timeStamp }; }}
                onPointerDown={(event) => { pressed.current = { id: pairing.id, key: false, at: event.timeStamp }; }}
                onClick={(event) => approve(pairing.id, event)}>{t("Approve")}</button>
              <button type="button" className="btn" disabled={deciding !== null} aria-busy={deciding === "decline" ? true : undefined} onClick={() => void decide(pairing.id, "decline")}>{t("Decline")}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
