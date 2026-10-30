/**
 * Signs Claude Code or Codex in from the browser. The server runs the agent's own login on the PC, in a
 * terminal tab as before (server/usage-login.ts); this dialog follows that tab: it shows the page to open
 * (and Codex's one-time code), takes the code Claude's page shows and types it into the login, and says
 * how it ended. The CLI writes its own credentials; the code lives only in the input until it is sent.
 * Open terminal hands over to the tab whenever the browser cannot follow (or the user would rather).
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, ExternalLink, SquareTerminal, X } from "lucide-react";

import type { UsageLoginPrompt, UsageLoginRequest } from "../../shared/usage-login.ts";
import { ApiError, fetchUsageLoginAccounts, fetchUsageLoginPrompt, sendUsageLoginCode, startUsageLogin } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { signInOutcome, type SignInOutcome } from "../lib/signInOutcome.ts";
import { PROVIDER_NAME } from "../lib/usage.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import "./UsageAccountDialog.css";

/** how often the dialog looks at the login's screen while it waits for the user */
const PROMPT_POLL_MS = 1000;
/** Codex's device code lives 15 minutes; a login still open past this is left to its terminal */
const FOLLOW_MS = 16 * 60_000;
/** reads of the login's screen that may fail in a row (a herdr busy for a moment) before the dialog hands over */
const READ_FAILURES_MAX = 3;

type Phase =
  | { kind: "starting" }
  | { kind: "confirm" }
  | { kind: "following"; pane: string }
  | { kind: "ended"; pane: string; outcome: SignInOutcome }
  | { kind: "failed"; message: string; pane: string | null };

export function UsageSignInDialog({ request, onOpenTerminal, onSignedIn, onClose }: {
  /** a first sign-in in the agent's own home, or signing an account in again */
  readonly request: Extract<UsageLoginRequest, { provider: "claude" | "codex" }>;
  /** shows the login's terminal tab (Settings closes) */
  readonly onOpenTerminal: (paneId: string) => void;
  /** the login ended with a new sign-in on the PC */
  readonly onSignedIn?: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const provider = request.provider;
  const [replace, setReplace] = useState(false);
  const again = "account" in request || replace;
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [prompt, setPrompt] = useState<UsageLoginPrompt | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const before = useRef<readonly (string | null)[] | null>(null);
  const signedInRef = useRef(onSignedIn);
  signedInRef.current = onSignedIn;
  const codeInput = useRef<HTMLInputElement>(null);
  // the code was sent, and the CLI has shown something else since: the follow loop reads these
  const sentRef = useRef(false);
  const answered = useRef(false);
  const surface = useFocusTrap<HTMLDivElement>(true);
  const title = t("Sign in to {provider}", { provider: provider === "claude" ? "Claude Code" : PROVIDER_NAME[provider] });

  // starts the login (again with `replace` once the user confirmed), after noting the sign-ins it may add to
  useEffect(() => {
    if (phase.kind !== "starting") return;
    const controller = new AbortController();
    void (async () => {
      try {
        before.current ??= (await fetchUsageLoginAccounts(provider, controller.signal)).accounts;
        const started = await startUsageLogin(replace && "default" in request ? { ...request, replace: true } : request, controller.signal);
        if (controller.signal.aborted) return;
        // a CLI the browser cannot follow: a Claude Code without `auth login` signs in inside the agent, and
        // a Codex without a device code answers on this PC's own localhost, out of a remote browser's reach
        if ((provider === "claude" && started.manual) || (provider === "codex" && !started.device_auth)) {
          setPhase({ kind: "failed", message: t("This version signs in only in its terminal. Open it to finish."), pane: started.pane_id });
          return;
        }
        setPhase({ kind: "following", pane: started.pane_id });
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.code === "account_confirmation_required") setPhase({ kind: "confirm" });
        else setPhase({ kind: "failed", message: cause instanceof ApiError ? cause.detail : t("Could not start account sign-in"), pane: null });
      }
    })();
    return () => controller.abort();
  }, [phase.kind, provider, replace, request, t]);

  // follows the login's screen until its CLI exits, then reads the sign-ins again
  const pane = phase.kind === "following" ? phase.pane : null;
  useEffect(() => {
    if (pane === null) return;
    const controller = new AbortController();
    const until = Date.now() + FOLLOW_MS;
    let timer: number | undefined;
    let failures = 0;
    const look = async (): Promise<void> => {
      try {
        const next = await fetchUsageLoginPrompt(pane, controller.signal);
        if (controller.signal.aborted) return;
        // a sent code the CLI moved on from; a prompt that comes back after that asks for the code again
        if (!next.wants_code) answered.current = true;
        else if (answered.current && sentRef.current) { sentRef.current = false; setSent(false); setCodeError(t("The sign-in asked for the code again. Paste it once more.")); }
        setPrompt(next);
        if (next.ended) {
          const after = (await fetchUsageLoginAccounts(provider, controller.signal)).accounts;
          window.dispatchEvent(new Event("herdr-usage-changed"));
          const outcome = signInOutcome(before.current ?? [], after, again);
          setPhase({ kind: "ended", pane, outcome });
          if (outcome.kind === "signed-in") signedInRef.current?.();
          return;
        }
        // a whole round read: only that clears the failures, so failed account reads after the end still count
        failures = 0;
      } catch (cause) {
        if (controller.signal.aborted) return;
        failures += 1;
        if (failures >= READ_FAILURES_MAX || (cause instanceof ApiError && cause.status === 404)) {
          setPhase({ kind: "failed", message: cause instanceof ApiError ? cause.detail : t("Could not follow the sign-in. Open its terminal."), pane });
          return;
        }
      }
      if (Date.now() > until) { setPhase({ kind: "failed", message: t("The sign-in is still open. Finish it in its terminal."), pane }); return; }
      timer = window.setTimeout(() => void look(), PROMPT_POLL_MS);
    };
    void look();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [pane, provider, again, t]);

  useLayoutEffect(() => {
    (surface.current?.querySelector<HTMLElement>(".account-step-content input, .account-step-content a, .account-step-content button") ?? surface.current)?.focus();
  }, [phase.kind, prompt?.url, prompt?.wants_code, surface]);

  const sendCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // a form inside another (Add account's): its submit is this one's alone
    event.stopPropagation();
    const input = codeInput.current;
    if (pane === null || input === null || sending) return;
    setSending(true); setCodeError(null);
    // the code is read from the input once and sent; nothing keeps it after
    void sendUsageLoginCode({ pane, code: input.value }).then(() => { input.value = ""; answered.current = false; sentRef.current = true; setSent(true); })
      .catch((cause: unknown) => setCodeError(cause instanceof ApiError ? cause.detail : t("Could not send the code")))
      .finally(() => setSending(false));
  };
  const copyCode = async (code: string): Promise<void> => {
    if (await copyText(code, null)) setCopied(true);
  };
  const terminalPane = phase.kind === "following" || phase.kind === "ended" ? phase.pane : phase.kind === "failed" ? phase.pane : null;

  let body;
  switch (phase.kind) {
    case "starting":
      body = <p className="settings-hint" role="status">{t("Starting the sign-in on this PC…")}</p>;
      break;
    case "confirm":
      body = <div className="account-auth-form">
        <p className="settings-hint">{t("{agent} is already signed in on this PC. Continuing may replace that sign-in.", { agent: provider === "claude" ? "Claude Code" : PROVIDER_NAME[provider] })}</p>
        <button type="button" className="btn" onClick={() => { setReplace(true); setPhase({ kind: "starting" }); }}>{t("Continue")}</button>
      </div>;
      break;
    case "following":
      body = prompt === null || prompt.url === null
        ? <p className="settings-hint" role="status">{t("Waiting for {provider} to show its sign-in page…", { provider: PROVIDER_NAME[provider] })}</p>
        : <div className="account-auth-form usage-sign-in-steps">
          <p className="settings-hint">{prompt.user_code !== null ? t("1. Open the sign-in page and sign in.") : t("Open the sign-in page and sign in.")}</p>
          <a className="btn usage-sign-in-open" href={prompt.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />{t("Open sign-in page")}</a>
          <span className="settings-hint usage-sign-in-host">{new URL(prompt.url).host}</span>
          {prompt.user_code !== null && <>
            <p className="settings-hint">{t("2. Enter this one-time code there:")}</p>
            <span className="usage-sign-in-code">
              <code>{prompt.user_code}</code>
              <button type="button" className="btn btn-ghost" aria-label={t("Copy the code")} onClick={() => void copyCode(prompt.user_code!)}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>
            </span>
            <p className="settings-hint" role="status">{t("Waiting for the page to approve it…")}</p>
          </>}
          {prompt.wants_code && !sent && <form className="usage-sign-in-paste" onSubmit={sendCode}>
            <label className="settings-label" htmlFor="usage-sign-in-code">{t("Paste the code the page shows")}</label>
            <input ref={codeInput} className="input" id="usage-sign-in-code" name="code" autoComplete="off" spellCheck={false} required maxLength={2048} pattern="[A-Za-z0-9._~#\-]+" disabled={sending} />
            {codeError && <p className="settings-hint account-error" role="alert">{codeError}</p>}
            <button type="submit" className="btn" disabled={sending}>{sending ? t("Sending…") : t("Send code")}</button>
          </form>}
          {(sent || (prompt.user_code === null && !prompt.wants_code)) && <p className="settings-hint" role="status">{t("Finishing the sign-in…")}</p>}
        </div>;
      break;
    case "ended":
      body = <p className={`settings-hint${phase.outcome.kind === "not-signed-in" ? " account-error" : ""}`} role={phase.outcome.kind === "not-signed-in" ? "alert" : "status"}>
        {phase.outcome.kind === "signed-in" ? (phase.outcome.account !== null ? t("Signed in as {account}.", { account: phase.outcome.account }) : t("Signed in."))
          : phase.outcome.kind === "finished" ? t("The sign-in finished.") : t("The sign-in ended without signing in. Try again, or sign in from a terminal.")}
      </p>;
      break;
    case "failed":
      body = <p className="settings-hint account-error" role="alert">{phase.message}</p>;
      break;
    default: { const unexpected: never = phase; throw new Error(String(unexpected)); }
  }

  return createPortal(<div className="modal-scrim" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <div ref={surface} className="modal usage-account-dialog usage-sign-in-dialog" role="dialog" aria-modal="true" aria-labelledby="usage-sign-in-title" tabIndex={-1}>
      <div className="modal-header">
        <h2 className="modal-title" id="usage-sign-in-title">{title}</h2>
        <button className="icon-button" type="button" aria-label={t("Close")} onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </div>
      <div className="modal-body">
        <div className="account-step-content">{body}</div>
        <div className="usage-sign-in-footer">
          {terminalPane !== null && phase.kind !== "ended" && <button type="button" className="btn btn-ghost" onClick={() => onOpenTerminal(terminalPane)}><SquareTerminal aria-hidden="true" />{t("Open terminal")}</button>}
          {(phase.kind === "ended" || phase.kind === "failed") && <button type="button" className="btn" onClick={onClose}>{t("Done")}</button>}
        </div>
      </div>
    </div>
  </div>, document.body);
}
