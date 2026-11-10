import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";

import "./DevicePairedNotice.css";
import "./RelayPairingPrompt.css";

import type { RelayPairingRequest } from "../../shared/protocol.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { failureText } from "./RelayPanel.tsx";

/** Whole seconds until `expiresAt`, never below 0; null for a time that does not read as one. */
export function secondsLeft(expiresAt: string, now: number): number | null {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Where the digits go in a sentence that names them in its middle, so each language keeps its own word order. */
const DIGITS = "\u0000";

/**
 * The devices waiting for this PC's approval (`relay-pairings`), a prompt each. One that arrives takes
 * the focus on its own surface, never on Approve, so a key typed for something else approves nothing;
 * as an alertdialog it also keeps Tab while a dialog's focus trap is open under it (lib/useFocusTrap.ts).
 */
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

  const [now, setNow] = useState(() => Date.now());
  const timed = pairings.some((pairing) => secondsLeft(pairing.expires_at, 0) !== null);
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timed]);

  const layer = useRef<HTMLDivElement>(null);
  const prompts = useRef(new Map<string, HTMLDivElement>());
  const seen = useRef(new Set<string>());
  /** the focus is, or was until its prompt went, inside the layer */
  const held = useRef(false);
  /** what had the focus before the first prompt took it */
  const opener = useRef<HTMLElement | null>(null);
  const ids = pairings.map((pairing) => pairing.id).join(" ");
  useLayoutEffect(() => {
    const arrived = pairings.filter((pairing) => !seen.current.has(pairing.id));
    seen.current = new Set(pairings.map((pairing) => pairing.id));
    const active = document.activeElement;
    // a prompt being read keeps the focus when another arrives
    if (layer.current?.contains(active)) return;
    // a new prompt takes it; so does the next one when the prompt that had it was decided or ran out,
    // but not when the person had taken the focus back to the page meanwhile
    const next = arrived[0] ?? (held.current ? pairings[0] : undefined);
    const node = next && prompts.current.get(next.id);
    if (!node) return;
    const before = held.current ? opener.current : active instanceof HTMLElement ? active : null;
    node.focus({ preventScroll: true });
    // refused under an inert pane column (a phone's open drawer): nothing was taken, so nothing goes back
    if (document.activeElement !== node) return;
    opener.current = before;
    held.current = true;
  }, [ids]);
  useLayoutEffect(() => {
    const node = layer.current;
    return () => {
      // the last prompt went: the focus it took goes back where it was, unless it has moved on since
      const active = document.activeElement;
      const from = opener.current;
      if (!held.current || !from?.isConnected) return;
      if (active === null || active === document.body || node?.contains(active)) from.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div ref={layer} className="relay-pairing-layer" role="region" aria-live="assertive" aria-label={t("Devices waiting for approval")}
      onFocus={() => { held.current = true; }}
      onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) held.current = false; }}>
      {pairings.map((pairing) => {
        const deciding = busy?.id === pairing.id ? busy.decision : null;
        const digits = <strong className="relay-pairing-digits">{`${pairing.digits.slice(0, 3)} ${pairing.digits.slice(3)}`}</strong>;
        // the other device shows an input, not digits (AddPcSheet): its person types this PC's there
        const [before, after = ""] = pairing.local_only
          ? t("{name} wants to add this PC to your account. Type {digits} on {name}, then press Approve here. Approve only after {name} accepted the number.", { name: pairing.label, digits: DIGITS }).split(DIGITS)
          : [`${t("{name} wants to pair through the relay. Approve it only if its screen shows", { name: pairing.label })} `];
        const left = secondsLeft(pairing.expires_at, now);
        return (
          <div key={pairing.id} ref={(node) => { if (node) prompts.current.set(pairing.id, node); else prompts.current.delete(pairing.id); }}
            className="update-notice is-paired relay-pairing-prompt" role="alertdialog" aria-modal="false" aria-labelledby={`${id}-${pairing.id}`} tabIndex={-1}
            data-testid="relay-pairing-prompt" data-local-only={pairing.local_only ? "true" : undefined}>
            <Smartphone aria-hidden="true" />
            <span>
              <span id={`${id}-${pairing.id}`}>{before}{digits}{after}</span>
              {/* a second that passes is not news: the layer announces the prompt, not its clock */}
              {left !== null && <span className="relay-pairing-left" aria-live="off" data-testid="relay-pairing-left"> {t("{n} s left", { n: left })}</span>}
              {failure?.id === pairing.id && <span className="relay-error" role="alert"> {failure.text}</span>}
            </span>
            <div className="device-paired-actions">
              <button type="button" className="btn btn-primary" disabled={deciding !== null} aria-busy={deciding === "approve" ? true : undefined} onClick={() => void decide(pairing.id, "approve")}>{t("Approve")}</button>
              <button type="button" className="btn" disabled={deciding !== null} aria-busy={deciding === "decline" ? true : undefined} onClick={() => void decide(pairing.id, "decline")}>{t("Decline")}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
