import { useEffect, useState } from "react";
import { useT } from "../lib/i18n.ts";
import { outOfReachWord } from "./relayPcState.tsx";
import "./Machines.css";

/** How long Check again stays held after a press: a burst of presses is one check (the server's own floor is 5 s too). */
export const RECHECK_HOLD_MS = 5_000;

// per PC and per page, not per row: a row drawn again (the inbox and back, a filter) keeps its hold
const heldUntil = new Map<string, number>();
const held = (key: string): number => Math.max(0, (heldUntil.get(key) ?? 0) - performance.now());

/**
 * Check again for one PC, held RECHECK_HOLD_MS from its press by the monotonic clock. `run` only asks: what it
 * finds arrives as the PC's next state, so its own answer is not waited for.
 */
export function useRecheck(key: string, run: () => void): { checking: boolean; check(): void } {
  const [checking, setChecking] = useState(() => held(key) > 0);
  useEffect(() => {
    if (!checking) return;
    const timer = setTimeout(() => setChecking(false), held(key));
    return () => clearTimeout(timer);
  }, [checking, key]);
  const check = () => {
    if (held(key) > 0) return;
    heldUntil.set(key, performance.now() + RECHECK_HOLD_MS);
    setChecking(true);
    run();
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
