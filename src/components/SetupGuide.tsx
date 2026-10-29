/**
 * The first-run setup guide (lib/setupGuideFlow.ts): a welcome, then Agent, Plan usage, Phone and
 * Alerts, each skippable, then Done, which opens the first workspace with the agent. It reuses what
 * Settings and the agent catalog already have (AgentSetupCard, the usage meter, the phone QR code,
 * the alerts switch) and adds no server route. Its layout follows the Claude and Codex apps' own
 * first runs: one question per screen in the main area, the app's sidebar left in place.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bell, Check, ChevronDown, ChevronRight, Circle, FolderOpen, Gauge, Gift, Info, LoaderCircle, Play, Plus, RotateCw, ShieldCheck, Smartphone, Sparkles, SquareTerminal } from "lucide-react";

import type { AgentCatalogEntry, AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { RemoteAccess } from "../../shared/protocol.ts";
import { createWorkspace, fetchAgentCatalog, fetchRemoteAccess } from "../lib/api.ts";
import type { SetupStep } from "../lib/agentSetup.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { createRequest, newSessionLaunch } from "../lib/newSession.ts";
import { phonePlan } from "../lib/phone.ts";
import type { PushActionResult } from "../lib/pushHealth.ts";
import { recentDirectories } from "../lib/recent-directories.ts";
import { useSettings } from "../lib/settings.ts";
import { agentView, checkList, foundAgents, guideProgress, PLAN_AGENT, settleDelay, usageOnByDefault, type CheckStatus, type GuideEvent, type GuidePlan, type GuideState, type GuideStepId, type PcCheck } from "../lib/setupGuideFlow.ts";
import { PROVIDER_NAME, useUsage } from "../lib/usage.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentSetupCard } from "./AgentSetupCard.tsx";
import { DirectoryBrowser, homeRelative } from "./DirectoryBrowser.tsx";
import { PhonePanel } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";
import { Toggle } from "./SettingsControls.tsx";
import { UsageProvider } from "./UsageMeters.tsx";
import "./SetupGuide.css";

/** a phone, where the step is adding Ovis to the home screen rather than scanning a code */
const PHONE_QUERY = "(max-width: 768px) and (pointer: coarse)";
/** recent folders offered at Done before "Choose another…" */
const FOLDERS_SHOWN = 3;
/** the catalog's agents, named in the check's lines before the PC answers */
type KnownAgent = Pick<AgentCatalogEntry, "id" | "name" | "kind">;

export interface SetupGuideProps {
  state: GuideState;
  /** stepped aside for a pane the user went to: kept mounted, so what runs goes on */
  hidden?: boolean;
  dispatch: (event: GuideEvent) => void;
  /** I've used Ovis before, Skip setup, or the first workspace opened */
  onClose: () => void;
  /** shows the tab an install or sign-in runs in */
  onOpenTerminal: (paneId: string) => void;
  onEnableNotifications: () => Promise<PushActionResult>;
  /** the first workspace opened: its pane, and whether the agent started in it */
  onOpened: (paneId: string, agentStarted: boolean) => void;
}

const basename = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || path;

export function SetupGuide(props: SetupGuideProps) {
  const { state, onClose, hidden = false } = props;
  const t = useT();
  const machineId = useMachineId();
  // the PC check: GET /api/agent-catalog for the PC being set up, run once the guide is begun and on Look again
  const [catalog, setCatalog] = useState<AgentCatalogRow[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [known, setKnown] = useState<readonly KnownAgent[]>([]);
  // said to a screen reader once the check is done; the step's heading changes without focus
  const [announced, setAnnounced] = useState("");
  const asked = useRef(0);
  const settle = useRef<number | undefined>(undefined);
  const loadCatalog = (): void => {
    const ask = ++asked.current;
    const startedAt = Date.now();
    window.clearTimeout(settle.current);
    setCatalog(null);
    setCatalogError(null);
    setAnnounced("");
    setChecking(true);
    // the catalog's names, kept out of the app's main bundle; without them the lines come with the answer
    import("../../shared/agent-catalog.ts").then((module) => setKnown(module.AGENT_CATALOG), () => {});
    fetchAgentCatalog(machineId).then((answer) => {
      if (ask !== asked.current) return;
      setCatalog(answer.agents);
      settle.current = window.setTimeout(() => {
        if (ask !== asked.current) return;
        setChecking(false);
        setAnnounced(foundAgents(answer.agents).length > 0 ? t("Your agents are already here") : t("Which AI do you already pay for?"));
      }, settleDelay(startedAt, Date.now()));
    }, (error: unknown) => {
      if (ask !== asked.current) return;
      setCatalogError(userErrorMessage(error).message);
      setChecking(false);
    });
  };
  const begun = state.step !== "welcome";
  useEffect(() => {
    if (begun) loadCatalog();
    return () => { asked.current += 1; window.clearTimeout(settle.current); };
  }, [begun, machineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const row = catalog?.find((candidate) => candidate.id === state.agent) ?? null;
  const check: PcCheck = { checking, catalog, failed: catalogError !== null };

  const step = state.step;
  useEffect(() => {
    if (step !== "welcome" && !hidden) document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [step, hidden]);

  if (state.step === "welcome") return <Welcome dispatch={props.dispatch} onClose={onClose} hidden={hidden} />;
  return (
    <div className="setup-guide" role="region" aria-label={t("Setup guide")} hidden={hidden}>
      <div className="setup-guide-inner">
        <Progress state={state} onClose={onClose} />
        <p className="visually-hidden" role="status">{state.step === "agent" ? announced : ""}</p>
        {state.step === "agent" && <AgentStep {...props} machineId={machineId} check={check} known={known} catalogError={catalogError} onReload={loadCatalog} row={row} />}
        {state.step === "usage" && <UsageStep state={state} dispatch={props.dispatch} row={row} />}
        {state.step === "phone" && <PhoneStep dispatch={props.dispatch} agentName={row?.name ?? null} />}
        {state.step === "alerts" && <AlertsStep dispatch={props.dispatch} agentName={row?.name ?? null} agentId={state.agent} onEnable={props.onEnableNotifications} />}
        {state.step === "done" && <DoneStep state={state} row={row} onOpened={props.onOpened} />}
      </div>
    </div>
  );
}

function Welcome({ dispatch, onClose, hidden }: Pick<SetupGuideProps, "dispatch" | "onClose" | "hidden">) {
  const t = useT();
  return (
    <div className="setup-guide" role="region" aria-label={t("Setup guide")} hidden={hidden}>
      <div className="setup-guide-inner setup-welcome">
        <img src="/icons/icon-192.png?v=sheep1" alt="" width="72" height="72" className="setup-welcome-mark" />
        <h2>{t("Welcome to Ovis")}</h2>
        <p className="setup-lead">{t("Is this your first time using Ovis?")}</p>
        <div className="setup-choices">
          <button type="button" className="setup-choice" onClick={() => dispatch({ type: "begin" })}>
            <span className="setup-choice-icon"><Sparkles aria-hidden="true" /></span>
            <span className="setup-choice-text"><strong>{t("I'm new to Ovis")}</strong><span>{t("Set it up with me. About 3 minutes, and you can skip any step.")}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
          <button type="button" className="setup-choice" onClick={onClose}>
            <span className="setup-choice-icon"><ArrowRight aria-hidden="true" /></span>
            <span className="setup-choice-text"><strong>{t("I've used Ovis before")}</strong><span>{t("Skip the setup and go straight in")}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <ul className="setup-topics" aria-label={t("What the setup covers")}>
          <li><SquareTerminal aria-hidden="true" />{t("An AI coding helper")}</li>
          <li><Gauge aria-hidden="true" />{t("Plan usage")}</li>
          <li><Smartphone aria-hidden="true" />{t("Your phone")}</li>
          <li><Bell aria-hidden="true" />{t("Alerts")}</li>
        </ul>
        <p className="setup-note"><Info aria-hidden="true" />{t("You can open this again any time from Settings → Setup guide.")}</p>
      </div>
    </div>
  );
}

const STEP_LABEL: Record<GuideStepId, string> = { agent: "Agent", usage: "Plan usage", phone: "Phone", alerts: "Alerts", done: "Done" };

function Progress({ state, onClose }: { state: GuideState; onClose: () => void }) {
  const t = useT();
  const { number, segments } = guideProgress(state);
  return (
    <div className="setup-progress">
      <div className="setup-progress-head">
        <span>{t("Setup · step {number} of 4", { number: number ?? 1 })}</span>
        <button type="button" className="setup-link" onClick={onClose}>{t("Skip setup")}</button>
      </div>
      <ol className="setup-progress-steps">
        {segments.map((segment) => (
          <li key={segment.id} data-state={segment.state} aria-current={segment.state === "now" ? "step" : undefined}>
            <span className="setup-progress-bar" aria-hidden="true" />
            <span className="setup-progress-label">{t(STEP_LABEL[segment.id])}</span>
            {segment.state === "skipped" && <span className="visually-hidden">{t("(skipped)")}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepActions({ primary, onSkip, skipLabel }: { primary?: ReactNode; onSkip: () => void; skipLabel?: string }) {
  const t = useT();
  return (
    <div className="setup-actions">
      {primary}
      <button type="button" className="setup-link setup-skip" onClick={onSkip}>{skipLabel ?? t("Skip for now")}</button>
    </div>
  );
}

function planFit(t: Translate, plan: GuidePlan): string {
  switch (plan) {
    case "claude": return t("Works with your Claude plan. Writes and fixes code in your projects.");
    case "chatgpt": return t("Works with your ChatGPT plan. Writes and fixes code in your projects.");
    case "free": return t("Free to start. Comes with free AI models, no account needed.");
  }
}

/** The card's first step for an agent the PC already has: signed in or not is the user's to say. */
function initialStep(row: AgentCatalogRow): SetupStep {
  if (row.state.installed !== true) return { kind: "idle" };
  return row.sign_in === null ? { kind: "ready", version: row.state.version } : { kind: "installed", version: row.state.version, onPath: row.state.on_path !== false };
}

function checkLine(t: Translate, status: CheckStatus): ReactNode {
  switch (status.kind) {
    case "looking": return <><LoaderCircle aria-hidden="true" className="agent-setup-spin" /><span className="visually-hidden">{t("Looking")}</span></>;
    case "installed": return <><Check aria-hidden="true" />{status.version === null ? t("Installed") : t("Installed · v{version}", { version: status.version })}</>;
    case "missing": return t("Not installed");
    case "unknown": return t("Can't tell");
  }
}

function AgentStep({ state, dispatch, onOpenTerminal, hidden = false, machineId, check, known, catalogError, onReload, row }: SetupGuideProps & { machineId: string; check: PcCheck; known: readonly KnownAgent[]; catalogError: string | null; onReload: () => void; row: AgentCatalogRow | null }) {
  const t = useT();
  const [others, setOthers] = useState(false);
  // Install another agent: the question, though the PC has agents
  const [installAnother, setInstallAnother] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const signedIn = useRef(false);
  // the step the card opens on, one per card shown: its first report (twice under StrictMode) is no move
  const initial = useMemo(() => row === null ? null : initialStep(row), [row?.id, state.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  const catalog = check.catalog;
  const recommended = new Set(Object.values(PLAN_AGENT));
  const otherAgents = (catalog ?? []).filter((candidate) => candidate.kind === "harness" && !recommended.has(candidate.id) && candidate.install !== null);
  const skip = () => dispatch({ type: "skip" });
  const lookAgain = (): void => { setInstallAnother(false); onReload(); };
  const view = agentView(check, installAnother);
  const shown = state.agent !== null && row !== null ? "card" : view;
  const shownBefore = useRef(shown);
  useEffect(() => {
    if (shownBefore.current === shown) return;
    shownBefore.current = shown;
    // the control that had focus went with the view it was in: the new view's heading takes it
    if (!hidden && (document.activeElement === null || document.activeElement === document.body)) document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [shown, hidden]);

  if (state.agent !== null && row !== null) {
    const onStep = (step: SetupStep): void => {
      // the step the card opened on: an agent already ready waits for Start
      if (step === initial) return;
      if (step.kind === "signing-in") signedIn.current = true;
      if (step.kind === "ready") dispatch({ type: "agent-ready", signedIn: signedIn.current });
    };
    return (
      <section className="setup-step" aria-labelledby="setup-step-title">
        <h2 id="setup-step-title" tabIndex={-1} className="visually-hidden">{t("Setting up {agent}", { agent: row.name })}</h2>
        {state.plan !== null && <p className="setup-lead">{planFit(t, state.plan)}</p>}
        <AgentSetupCard key={row.id} agent={row} machineId={machineId} initial={initial ?? initialStep(row)} onOpenTerminal={onOpenTerminal} onStart={() => dispatch({ type: "agent-ready", signedIn: signedIn.current })} onStep={onStep} />
        <StepActions primary={<button type="button" className="btn btn-ghost" onClick={() => dispatch({ type: "back" })}><ArrowLeft aria-hidden="true" />{t("Back")}</button>} onSkip={skip} skipLabel={t("Skip this step")} />
      </section>
    );
  }

  if (view === "checking") {
    const lines = checkList(known, catalog);
    return (
      <section className="setup-step" aria-labelledby="setup-step-title">
        <h2 id="setup-step-title" tabIndex={-1}>{t("Checking this PC…")}</h2>
        <p className="setup-lead">{t("Looking for AI coding helpers that are already installed.")}</p>
        {lines.length > 0 && (
          <ul className="setup-check" aria-busy={catalog === null}>
            {lines.map((line) => (
              <li key={line.id} data-status={line.status.kind}>
                <AgentMark agent={line.id} size={18} />
                <span className="setup-check-name">{line.name}</span>
                <span className="setup-check-status">{checkLine(t, line.status)}</span>
              </li>
            ))}
          </ul>
        )}
        <StepActions onSkip={skip} skipLabel={t("Skip this step")} />
      </section>
    );
  }

  if (view === "found" && catalog !== null) {
    const found = foundAgents(catalog);
    const chosen = found.find((agent) => agent.id === picked) ?? found[0]!;
    return (
      <section className="setup-step" aria-labelledby="setup-step-title">
        <h2 id="setup-step-title" tabIndex={-1}>{t("Your agents are already here")}</h2>
        <p className="setup-lead">{t("Ovis found these on this PC. Pick the one your first workspace opens with.")}</p>
        <p className="setup-label" id="setup-found-label">{t("Found on this PC")}</p>
        <div className="setup-choices" role="group" aria-labelledby="setup-found-label">
          {found.map((agent) => (
            <button key={agent.id} type="button" className="setup-choice setup-found" aria-pressed={agent.id === chosen.id} onClick={() => setPicked(agent.id)}>
              <span className="setup-choice-icon"><AgentMark agent={agent.id} size={24} /></span>
              <span className="setup-found-name"><strong>{agent.name}</strong>{agent.state.version !== null && <span>{agent.state.version}</span>}</span>
              {agent.id === chosen.id && <Check aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="setup-actions">
          <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: "choose", plan: null, agent: chosen.id })}><Play aria-hidden="true" />{t("Continue with {agent}", { agent: chosen.name })}</button>
          <button type="button" className="setup-link setup-install-another" onClick={() => setInstallAnother(true)}><Plus aria-hidden="true" />{t("Install another agent")}</button>
          <button type="button" className="setup-link setup-skip" onClick={skip}>{t("Skip this step")}</button>
        </div>
      </section>
    );
  }

  const plans: { plan: GuidePlan; mark: string | null; title: string; sub: string }[] = [
    { plan: "claude", mark: "claude", title: "Claude", sub: t("Pro or Max plan") },
    { plan: "chatgpt", mark: "codex", title: "ChatGPT", sub: t("Plus or Pro plan") },
    { plan: "free", mark: null, title: t("Neither"), sub: t("Start with a free option") },
  ];
  return (
    <section className="setup-step" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title" tabIndex={-1}>{t("Which AI do you already pay for?")}</h2>
      <p className="setup-lead">{t("We'll install the coding helper that works with it and sign you in.")}</p>
      {catalogError !== null && <p className="setup-error" role="alert">{catalogError}</p>}
      <div className="setup-choices">
        {plans.map(({ plan, mark, title, sub }) => (
          <button key={plan} type="button" className="setup-choice" disabled={catalog === null} onClick={() => dispatch({ type: "choose", plan, agent: PLAN_AGENT[plan] })}>
            <span className="setup-choice-icon">{mark === null ? <Gift aria-hidden="true" /> : <AgentMark agent={mark} size={28} />}</span>
            <span className="setup-choice-text"><strong>{title}</strong><span>{sub}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
        ))}
      </div>
      {otherAgents.length > 0 && (
        <div className="setup-others">
          <button type="button" className="setup-link setup-others-toggle" aria-expanded={others} onClick={() => setOthers((open) => !open)}>
            {others ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{t("Other agents ({count})", { count: otherAgents.length })}
          </button>
          {others && (
            <ul className="setup-others-list">
              {otherAgents.map((candidate) => (
                <li key={candidate.id}>
                  <button type="button" className="setup-other" onClick={() => dispatch({ type: "choose", plan: null, agent: candidate.id })}>
                    <AgentMark agent={candidate.id} size={18} /><span>{candidate.name}</span>
                    {candidate.state.installed === true && <span className="setup-badge">{t("Already installed")}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="setup-actions">
        <span className="setup-muted">{t("Already installed one?")}</span>
        <button type="button" className="btn btn-ghost" onClick={lookAgain}><RotateCw aria-hidden="true" />{t("Look again")}</button>
        <button type="button" className="setup-link setup-skip" onClick={skip}>{t("Skip this step")}</button>
      </div>
    </section>
  );
}

function UsageStep({ state, dispatch, row }: { state: GuideState; dispatch: (event: GuideEvent) => void; row: AgentCatalogRow | null }) {
  const t = useT();
  const { settings, update } = useSettings();
  const byDefault = usageOnByDefault(state);
  const [on, setOn] = useState(() => settings.showUsage || byDefault);
  // nothing is read from the providers while the switch is off: the preview asks only once it is on
  const { report } = useUsage(on);
  const provider = row?.sign_in?.provider ?? null;
  const name = provider === null ? null : PROVIDER_NAME[provider];
  const shown = (report?.providers ?? []).filter((usage) => provider === null || usage.id === provider);
  const now = useMemo(() => Date.now(), [report]);
  const finish = () => {
    if (on !== settings.showUsage) update({ showUsage: on });
    dispatch({ type: "complete" });
  };
  return (
    <section className="setup-step setup-card" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title" tabIndex={-1}>{t("Show how much of your plan is left?")}</h2>
      <p className="setup-lead">{name === null
        ? t("Paid plans limit how much you can use them every few hours and every week. Ovis can show what's left, so you're not cut off by surprise.")
        : t("{name} limits how much you can use it every few hours and every week. Ovis can show what's left, so you're not cut off by surprise.", { name })}</p>
      <div className="setup-preview">
        <p className="setup-preview-title">{name === null ? t("Preview of plan usage") : t("Preview · your {name} account", { name })}</p>
        {on && shown.length > 0
          ? shown.map((usage) => <UsageProvider key={usage.key} usage={usage} now={now} count={settings.usageCount} onLocalLogin={undefined} />)
          : <p className="setup-muted">{on ? t("Nothing to show yet. It appears once an agent is signed in on this PC.") : t("Turn it on to see your own numbers here.")}</p>}
        <p className="setup-preview-where"><Gauge aria-hidden="true" />{t("It sits at the bottom of the sidebar. Click it for the details.")}</p>
      </div>
      <div className="setup-switch">
        <div>
          <strong id="setup-usage-label">{t("Show plan usage")}</strong>
          <span>{byDefault ? t("On, because you just signed in. Change it later in Settings.") : t("Change it later in Settings → Subscription usage.")}</span>
        </div>
        <Toggle label={t("Show plan usage")} checked={on} onChange={setOn} />
      </div>
      <StepActions primary={<button type="button" className="btn btn-primary" onClick={finish}>{t("Continue")}</button>} onSkip={() => dispatch({ type: "skip" })} />
      <p className="setup-note"><ShieldCheck aria-hidden="true" />{t("Ovis only reads your limits. It never changes your plan or signs you out.")}</p>
    </section>
  );
}

function PhoneStep({ dispatch, agentName }: { dispatch: (event: GuideEvent) => void; agentName: string | null }) {
  const t = useT();
  const phone = useMediaQuery(PHONE_QUERY);
  const installPrompt = useInstallPrompt();
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const loadAccess = (): void => {
    setAccess(undefined);
    fetchRemoteAccess().then(setAccess, () => setAccess(null));
  };
  useEffect(() => { if (!phone) loadAccess(); }, [phone]);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }, access ?? null);
  const continueButton = <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: "complete" })}>{t("Continue")}</button>;
  return (
    <section className="setup-step setup-card" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title" tabIndex={-1}>{t("Use Ovis on your phone too")}</h2>
      <p className="setup-lead">{agentName === null ? t("Check on your agents and answer them from anywhere. Optional.") : t("Check on {agent} and answer it from anywhere. Optional.", { agent: agentName })}</p>
      {phone ? (
        <div className="setup-phone-here">
          <p>{installPrompt.installed ? t("Ovis is already on your home screen.") : t("You're already on a phone. Add Ovis to your home screen so it opens like an app and can send you alerts.")}</p>
          {!installPrompt.installed && (installPrompt.canInstall
            ? <button type="button" className="btn" onClick={() => void installPrompt.install()}>{t("Install app")}</button>
            : <p className="setup-muted">{installPrompt.help}</p>)}
        </div>
      ) : plan.kind === "here" || plan.kind === "served" ? (
        <div className="setup-qr">
          <QrCode value={plan.url} label={t("QR code: {url}", { url: plan.url })} />
          <ol>
            <li>{t("Point your phone's camera at the code.")}</li>
            <li>{t("Open the link. It's {url}.", { url: plan.url })}</li>
            <li>{t("Add it to your home screen when asked.")}</li>
          </ol>
        </div>
      ) : <PhonePanel plan={plan} loading={access === undefined} onRefresh={loadAccess} />}
      <StepActions primary={continueButton} onSkip={() => dispatch({ type: "skip" })} />
    </section>
  );
}

function AlertsStep({ dispatch, agentName, agentId, onEnable }: { dispatch: (event: GuideEvent) => void; agentName: string | null; agentId: string | null; onEnable: () => Promise<PushActionResult> }) {
  const t = useT();
  const { settings, update } = useSettings();
  const [asks, setAsks] = useState(settings.alertInput);
  const [finishes, setFinishes] = useState(settings.alertDone !== "off");
  const [busy, setBusy] = useState(false);
  const who = agentName ?? t("your agent");
  const turnOn = async (): Promise<void> => {
    setBusy(true);
    update({ alertInput: asks, alertDone: finishes ? settings.alertDone === "off" ? "long" : settings.alertDone : "off" });
    // in-app alerts are on whatever the browser answers; the browser's own answer is kept by Settings → Alerts
    try { await onEnable(); } catch { /* in-app alerts are on; Settings → Alerts says what the browser refused */ } finally { setBusy(false); }
    dispatch({ type: "complete" });
  };
  return (
    <section className="setup-step setup-card" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title" tabIndex={-1}>{agentName === null ? t("Get a nudge when an agent needs you") : t("Get a nudge when {agent} needs you", { agent: agentName })}</h2>
      <p className="setup-lead">{t("So you can walk away while it works. It looks like this:")}</p>
      <div className="setup-sample" aria-hidden="true">
        <AgentMark agent={agentId ?? "claude"} size={22} />
        <span className="setup-sample-text"><strong>{agentName ?? "Claude Code"} · my-project</strong><span>{t("Wants to run the tests. Allow?")}</span></span>
        <span className="setup-sample-badge">{t("Needs your answer")}</span>
      </div>
      <div className="setup-switch">
        <div><strong>{t("When {agent} asks you something", { agent: who })}</strong><span>{t("A question or a permission")}</span></div>
        <Toggle label={t("When {agent} asks you something", { agent: who })} checked={asks} onChange={setAsks} />
      </div>
      <div className="setup-switch">
        <div><strong>{t("When {agent} finishes a long job", { agent: who })}</strong><span>{t("Only work that took a minute or more")}</span></div>
        <Toggle label={t("When {agent} finishes a long job", { agent: who })} checked={finishes} onChange={setFinishes} />
      </div>
      <StepActions primary={<button type="button" className="btn btn-primary" disabled={busy || (!asks && !finishes)} onClick={() => void turnOn()}><Bell aria-hidden="true" />{t("Turn on alerts")}</button>} onSkip={() => dispatch({ type: "skip" })} />
      <p className="setup-note"><Info aria-hidden="true" />{t("Your browser will ask once whether Ovis may show notifications. Choose Allow.")}</p>
    </section>
  );
}

function DoneStep({ state, row, onOpened }: { state: GuideState; row: AgentCatalogRow | null; onOpened: SetupGuideProps["onOpened"] }) {
  const t = useT();
  const { settings } = useSettings();
  const [recent] = useState(() => recentDirectories.read("local").slice(0, FOLDERS_SHOWN));
  const [folder, setFolder] = useState<string | null>(recent[0] ?? null);
  const [browsing, setBrowsing] = useState(recent.length === 0);
  // the folder the browser last said it shows, and how its Use this folder names it: the pick keeps the
  // absolute path for it; any other pick (a home it fell back to, the folder asked for gone) is taken as given
  const shownFolder = useRef<string | null>(null);
  const shownPicked = useRef<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the agent set up is the saved choice; the catalog, which may still be loading, only lends its name
  const agentId = state.outcomes.agent === "done" ? state.agent : null;
  const agent = agentId === null ? null : { id: agentId, name: row?.name ?? agentId };
  // the workspace made, when the agent did not start in it: opening it shows why, in its terminal
  const [madeWithout, setMadeWithout] = useState<string | null>(null);
  const lines: { id: string; done: boolean; text: string; later: string }[] = [
    { id: "agent", done: agent !== null, text: agent !== null ? t("{agent} is set up", { agent: agent.name }) : t("Agent skipped"), later: t("Settings → Setup guide") },
    { id: "usage", done: state.outcomes.usage === "done" && settings.showUsage, text: state.outcomes.usage === "done" && settings.showUsage ? t("Plan usage shown in the sidebar") : t("Plan usage skipped"), later: t("Settings → Subscription usage") },
    { id: "phone", done: state.outcomes.phone === "done", text: state.outcomes.phone === "done" ? t("Phone set up") : t("Phone skipped"), later: t("Settings → Phone & devices") },
    { id: "alerts", done: state.outcomes.alerts === "done", text: state.outcomes.alerts === "done" ? t("Alerts on") : t("Alerts skipped"), later: t("Settings → Alerts") },
  ];
  const open = async (): Promise<void> => {
    if (madeWithout !== null) { onOpened(madeWithout, false); return; }
    if (folder === null || opening) return;
    setOpening(true);
    setError(null);
    const launch = newSessionLaunch({ agent: agent?.id ?? "", model: "", effort: "", prompt: "" }, settings);
    if ("fault" in launch) { setOpening(false); return; }
    try {
      const result = await createWorkspace(createRequest({ tab: null, directory: folder, name: "" }, launch, null));
      recentDirectories.remember("local", [folder], true);
      if (agent !== null && result.agent_started === false) {
        setOpening(false);
        setMadeWithout(result.pane_id);
        setError(t("The workspace opened, but {agent} did not start. Open it to see why in its terminal.", { agent: agent.name }) + (result.error?.message ? ` (${result.error.message})` : ""));
        return;
      }
      onOpened(result.pane_id, agent !== null);
    } catch (reason: unknown) {
      setOpening(false);
      setError(userErrorMessage(reason).message);
    }
  };
  return (
    <section className="setup-step setup-card" aria-labelledby="setup-step-title">
      <div className="setup-done-head">
        <Check aria-hidden="true" />
        <div>
          <h2 id="setup-step-title" tabIndex={-1}>{t("You're all set")}</h2>
          <p className="setup-lead">{agent !== null ? t("Pick a project and {agent} opens in it.", { agent: agent.name }) : t("Pick a project to open.")}</p>
        </div>
      </div>
      <ul className="setup-summary">
        {lines.map((line) => (
          <li key={line.id} data-done={line.done}>
            {line.done ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
            <span>{line.text}</span>
            {!line.done && <span className="setup-later">{line.later}</span>}
          </li>
        ))}
      </ul>
      <p className="setup-label" id="setup-folder-label">{t("Project folder")}</p>
      <div className="setup-folders" role="group" aria-labelledby="setup-folder-label">
        {recent.map((path) => (
          <button key={path} type="button" className="setup-folder" aria-pressed={folder === path && !browsing} title={path} onClick={() => { setFolder(path); setBrowsing(false); }}>
            <FolderOpen aria-hidden="true" />{basename(path)}
          </button>
        ))}
        <button type="button" className="setup-folder" aria-pressed={browsing} onClick={() => setBrowsing(true)}><FolderOpen aria-hidden="true" />{t("Choose another…")}</button>
      </div>
      {browsing && <div className="setup-browser"><DirectoryBrowser start={folder ?? ""} onPick={(picked) => { setFolder((shown) => shown !== null && shownFolder.current === shown && picked === shownPicked.current ? shown : picked); setBrowsing(false); }} onFolder={(path, home) => { shownFolder.current = path; shownPicked.current = homeRelative(path, home); setFolder(path); }} /></div>}
      {error !== null && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="btn btn-primary" disabled={(folder === null && madeWithout === null) || opening} onClick={() => void open()}>
          <Play aria-hidden="true" />{madeWithout !== null ? t("Open the workspace") : folder === null ? t("Choose a project folder") : agent !== null ? t("Open {folder} with {agent}", { folder: basename(folder), agent: agent.name }) : t("Open {folder}", { folder: basename(folder) })}
        </button>
      </div>
      <p className="setup-note"><Info aria-hidden="true" />{t("Open this guide again any time: Settings → Setup guide.")}</p>
    </section>
  );
}

/** Over the pane while the guide stands aside for a tab the user opened from it. */
export function SetupGuideResume({ onResume }: { onResume: () => void }) {
  const t = useT();
  return (
    <p className="setup-resume" role="status">
      <span>{t("The setup guide is waiting for you.")}</span>
      <button type="button" className="btn btn-ghost" onClick={onResume}>{t("Back to setup")}</button>
    </p>
  );
}
