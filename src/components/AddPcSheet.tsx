/**
 * Adding a PC, step by step: a sheet with four segmented bars and the steps of the join it drives,
 * in the mode the front page picks today (AccountPcs.tsx; `addPcSheetMode`). A PC new in the
 * account (newPcs) has this device type the number that PC shows, then approve on the PC; any other
 * PC that waits for this device asks through the account, this device shows its own number, and an
 * account member approves on another device, never on the PC's own screen (docs/account.md,
 * "Joining through the account"). Both call the shell's existing join, Pair, match and Cancel, and
 * the steps advance from the shell's state: nothing here talks to the network, forces the typed
 * mode or skips a comparison; the comparison on screen follows the state's `typed`, as the shell's
 * own screen does. Without a PC the sheet says how one is added. The step list follows GOAT's
 * connection phases (its onboarding bars and SSH runtime steps); no code is borrowed.
 */
// the digit field and the comparison's digits are the relay shell's own rules, so both screens draw them alike
import "./RelayShell.css";
import "./AddPcSheet.css";

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

import { newPcs, type MyPc } from "../lib/account/myPcs.ts";
import { useT } from "../lib/i18n.ts";
import type { RelayFailure, RelayShellState } from "../lib/relay/shellState.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { TypedDigits } from "./RelayShell.tsx";

/** `new`: the PC's card (typed number); `join`: the row of a PC waiting for approval (account join); `add`: no PC, how one is added. */
export type AddPcSheetMode = "new" | "join" | "add";

/**
 * The mode a PC opens the sheet in, by the front page's rule: a PC new in the account is its card
 * (this device types the number it shows), any other PC this device can join asks through the
 * account, and a PC already paired, or one with no key to compare, is nothing to join.
 */
export function addPcSheetMode(pc: MyPc | null, now: number): AddPcSheetMode {
  if (pc === null || pc.paired || pc.join === undefined) return "add";
  return newPcs([pc], now).length > 0 ? "new" : "join";
}

/** Where the join is, read off the shell's state: the step list and the sheet's controls follow it. */
export type AddPcPhase = "start" | "confirm" | "connecting" | "compare" | "wrong" | "approving" | "failed" | "ready";

export function addPcPhase(pc: MyPc, state: RelayShellState): AddPcPhase {
  if (pc.paired) return "ready";
  switch (state.kind) {
    case "confirm": return state.offer.server_id === pc.server_id ? "confirm" : "start";
    case "connecting": return "connecting";
    case "compare": return state.wrong ? "wrong" : state.confirmed ? "approving" : "compare";
    case "failed": return "failed";
    default: return "start";
  }
}

export type AddPcStepStatus = "done" | "running" | "todo" | "failed";

/**
 * The four steps' marks for a phase: the join's steps are done up to the one the phase is at, which
 * runs, or failed there. A new PC has signed in before its card shows; an account join's ask is
 * done once the relay produced digits; a refusal after digits is the approval's, any other failure
 * the step that was connecting.
 */
export function addPcSteps(mode: "new" | "join", phase: AddPcPhase, failure: RelayFailure | null): AddPcStepStatus[] {
  const at = phase === "ready" ? 4
    : phase === "approving" || (phase === "failed" && failure === "pair-declined") ? 2
    : mode === "new" ? 1
    : phase === "compare" || phase === "wrong" ? 1
    : 0;
  return [0, 1, 2, 3].map((step) => step < at ? "done" : step > at ? "todo" : phase === "failed" ? "failed" : "running");
}

function failureTitle(t: ReturnType<typeof useT>, failure: RelayFailure, name: string): string {
  switch (failure) {
    case "pair-declined": return t("{name} did not approve this phone", { name });
    case "pair-unavailable": return t("{name} is not taking new phones right now", { name });
    case "not-added-yet": return t("{name} has not added this device yet", { name });
    case "pc-offline": return t("{name} is offline", { name });
    case "pc-unresponsive": return t("{name} did not finish connecting", { name });
    case "relay-unreachable": return t("The relay could not be reached");
    case "needs-update": return t("Update needed");
    case "revoked": return t("This phone was removed from {name}", { name });
    case "identity-changed": return t("{name} has a new identity", { name });
    case "code-expired": return t("That pairing code no longer works");
    case "bad-offer": return t("This pairing link is damaged");
  }
}

export interface AddPcSheetProps {
  /** which flow the sheet walks; `addPcSheetMode(pc, now)` picks it as the front page does */
  mode: AddPcSheetMode;
  /** the PC joined; null in the `add` mode, which only says how a PC is added */
  pc: MyPc | null;
  /** the shell's state of this PC's join (RelayShellProps.state): the steps advance from it */
  state: RelayShellState;
  /** the shell's join (RelayShellProps.onJoin): typed from a PC's card, plain for an account join */
  onJoin: (pc: MyPc, options?: { typed?: boolean }) => void;
  /** the shell's Pair, answering the question an offer link asks (RelayShellProps.onPair) */
  onPair: () => void;
  /** the shell's match (RelayShellProps.onMatch): the digits typed from the PC's screen, or nothing when this device shows them */
  onMatch: (typed?: string) => void;
  /** the shell's Cancel (RelayShellProps.onCancel): ends a connection or comparison in progress */
  onCancel: () => void;
  /** takes the sheet down; the focus goes back to what opened it */
  onClose: () => void;
  /** the `add` mode's way to the existing QR and code pairing screen */
  onPairByQr: () => void;
}

export function AddPcSheet({ mode, pc, state, onJoin, onPair, onMatch, onCancel, onClose, onPairByQr }: AddPcSheetProps) {
  const t = useT();
  const id = useId();
  const name = pc?.name ?? "";
  const phase = pc === null || mode === "add" ? null : addPcPhase(pc, state);
  // the phase's own control: the one the focus starts on, and lands on again when a phase change took the last one away
  const primary = useRef<HTMLButtonElement>(null);
  const open = useRef<HTMLAnchorElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: phase === "ready" ? open : primary });
  useLayoutEffect(() => {
    const node = surface.current;
    if (node === null || node.contains(document.activeElement)) return;
    (primary.current ?? open.current ?? node).focus({ preventScroll: true });
  }, [phase]);
  // while the join runs, Cancel, Escape and the scrim end it in the shell too, as today's Cancel and Not now do
  const close = (): void => {
    if (phase !== null && phase !== "start" && phase !== "ready") onCancel();
    onClose();
  };
  const latestClose = useRef(close);
  latestClose.current = close;
  useSheetSwipe(surface, close);
  usePhoneSheetBack(() => { latestClose.current(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // a native modal over it takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      latestClose.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const cancel = <button type="button" className="btn" onClick={close}>{t("Cancel")}</button>;
  const done = <button ref={primary} type="button" className="btn" onClick={close}>{t("Close")}</button>;
  let title: string;
  let sub: string;
  let body: ReactNode = null;
  let actions: ReactNode;
  if (phase === null || pc === null) {
    title = t("Add a PC");
    sub = t("A PC joins through your account, or pairs with this device alone.");
    body = (
      <>
        <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs, sign in and choose Add this PC to my account. It then appears here to add.")}</p>
        <p className="relay-shell-copy">{t("Without an account on the PC, pair this device with the QR code or pairing code it shows.")}</p>
      </>
    );
    actions = (
      <>
        <button type="button" className="btn" onClick={onClose}>{t("Close")}</button>
        <button ref={primary} type="button" className="btn btn-primary" onClick={onPairByQr}>{t("Pair with a QR or code")}</button>
      </>
    );
  } else {
    title = mode === "new" ? t("Add {name} to your account", { name }) : t("Add this device to {name}", { name });
    sub = mode === "new" ? t("Type the number {name} shows on its own screen, then approve there.", { name }) : t("The number to check appears on another of your devices, not on {name}.", { name });
    switch (phase) {
      case "start":
        actions = mode === "new"
          ? <>{cancel}<button ref={primary} type="button" className="btn btn-primary" onClick={() => onJoin(pc, { typed: true })}>{t("Add this PC")}</button></>
          : <>{cancel}<button ref={primary} type="button" className="btn btn-primary" onClick={() => onJoin(pc)}>{t("Ask to join")}</button></>;
        break;
      case "confirm":
        body = <p className="relay-shell-copy">{t("Pair with {name}?", { name })}</p>;
        actions = <>{cancel}<button ref={primary} type="button" className="btn btn-primary" onClick={onPair}>{t("Pair")}</button></>;
        break;
      case "connecting":
        body = <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Connecting to {name}…", { name })}</span></div>;
        actions = cancel;
        break;
      case "compare": {
        // the digits are typed only when the shell asks for them, whatever the mode: a comparison is never made stricter or looser here
        const typed = state.kind === "compare" && state.typed === true;
        const digits = state.kind === "compare" ? state.digits : "";
        if (typed) {
          body = <div className="add-pc-typed"><TypedDigits pc={name} onSubmit={onMatch} cancel={cancel} /></div>;
          actions = null;
        } else {
          body = (
            <>
              <p className="relay-shell-digits" aria-label={digits.split("").join(" ")}>{`${digits.slice(0, 3)} ${digits.slice(3)}`}</p>
              <p className="relay-shell-copy">{t("Another of your devices shows three numbers: pick this one there.")}</p>
            </>
          );
          actions = <>{cancel}<button ref={primary} type="button" className="btn btn-primary" onClick={() => onMatch()}>{t("The numbers match")}</button></>;
        }
        break;
      }
      case "wrong":
        body = (
          <div role="alert">
            <p className="add-pc-problem">{t("That is not the number {name} shows", { name })}</p>
            <p className="relay-shell-copy">{t("Nothing was added. Tap the PC again to compare a new number, and type the one its own screen shows.")}</p>
          </div>
        );
        actions = done;
        break;
      case "approving":
        body = (
          <div className="relay-shell-wait" role="status">
            <div className="boot-spinner" aria-hidden="true" />
            <p className="relay-shell-detail">{mode === "new" ? t("Approve this phone on {name} to finish.", { name }) : t("Waiting for an account member to approve this device…")}</p>
          </div>
        );
        actions = cancel;
        break;
      case "failed":
        body = <p className="add-pc-problem" role="alert">{state.kind === "failed" ? failureTitle(t, state.failure, name) : null}</p>;
        actions = done;
        break;
      case "ready":
        actions = (
          <>
            <button type="button" className="btn" onClick={onClose}>{t("Close")}</button>
            <a ref={open} className="btn btn-primary" href={serverScopePath(pc.server_id)}>{t("Open {name}", { name })}</a>
          </>
        );
        break;
    }
  }

  const steps = phase === null || pc === null ? null : (mode === "new" ? [
    [t("{name} signed in", { name }), t("It asked to join your account")],
    [t("Type the number {name} shows", { name }), t("Proves you are looking at that PC")],
    [t("Approve on {name}", { name }), t("The PC decides who gets in, not the account")],
    [t("Ready"), t("Every device of your account can open it")],
  ] : [
    [t("Ask to join"), t("Through your account, with this device's key")],
    [t("Check the number on another of your devices"), t("It shows three; pick the one this device shows")],
    [t("Approved by an account member"), t("On that device, never on {name} itself", { name })],
    [t("Ready"), t("This device can open {name}", { name })],
  ]).map(([label, detail], step) => ({ label, detail, status: addPcSteps(mode === "new" ? "new" : "join", phase, state.kind === "failed" ? state.failure : null)[step]! }));

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={surface} className="modal add-pc-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-sub`} tabIndex={-1} data-add-pc-mode={mode} {...(phase === null ? {} : { "data-add-pc-phase": phase })}>
        <header className="modal-header add-pc-head">
          {steps && <div className="add-pc-bars" aria-hidden="true">{steps.map(({ status }, step) => <span key={step} data-bar={status} />)}</div>}
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          <p className="add-pc-sub" id={`${id}-sub`}>{sub}</p>
        </header>
        <div className="modal-body add-pc-body">
          {body}
          {steps && (
            <ol className="add-pc-steps">
              {steps.map(({ label, detail, status }, step) => (
                <li key={step} data-step={status} {...(status === "running" ? { "aria-current": "step" } : {})}>
                  <span className="add-pc-mark" aria-hidden="true">{status === "done" ? <Check /> : status === "failed" ? <X /> : null}</span>
                  <span className="add-pc-step-text">
                    <span className="add-pc-step-label">{label}</span>
                    <span className="add-pc-step-detail">{detail}</span>
                  </span>
                  {status === "done" && <span className="visually-hidden">{t("Done")}</span>}
                  {status === "failed" && <span className="visually-hidden">{t("Failed")}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
        {actions !== null && <footer className="modal-footer">{actions}</footer>}
      </div>
    </div>,
    document.body,
  );
}
