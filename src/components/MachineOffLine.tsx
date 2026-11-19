import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n.ts";
import { outOfReachWord } from "./relayPcState.tsx";
import "./Machines.css";

/** How long Check again stays held after a press, its own check included: a burst of presses is one reconnect. */
export const RECHECK_HOLD_MS = 5_000;

/**
 * One check at a time, held for RECHECK_HOLD_MS from its press however soon it ends. `run` reports its own
 * failure (the row's error line): a rejection still ends the hold.
 */
export function useRecheck(run: () => Promise<unknown>): { checking: boolean; check(): void } {
  const [checking, setChecking] = useState(false);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const check = () => {
    if (held.current) return;
    held.current = true;
    setChecking(true);
    const pressed = Date.now();
    const release = () => {
      timer.current = setTimeout(() => { held.current = false; setChecking(false); }, Math.max(0, pressed + RECHECK_HOLD_MS - Date.now()));
    };
    run().then(release, release);
  };
  return { checking, check };
}

/**
 * A PC that does not answer, on its sidebar row: one word for its state, why under it, and Check again (the
 * account's PCs list and Needs you say the same, relayPcState.tsx). `off`: nothing answered for the PC;
 * `unreachable`: what stands between this server and the PC (the relay) did not answer, so the PC may be on.
 */
export function MachineOffLine({ state, reason, title, checking, onCheck }: { state: "off" | "unreachable"; reason: string | null; title?: string; checking: boolean; onCheck(): void }) {
  const t = useT();
  return <div className="machine-off">
    <p className="machine-state is-off" role="status" title={title}>
      <span className="machine-state-word">{state === "off" ? t("Switched off") : outOfReachWord("unreachable", t)}</span>
      {reason !== null && <span className="machine-state-detail">{reason}</span>}
    </p>
    <button type="button" className="btn machine-recheck" aria-disabled={checking || undefined} aria-busy={checking || undefined} onClick={() => { if (!checking) onCheck(); }}>{t(checking ? "Checking…" : "Check again")}</button>
  </div>;
}
