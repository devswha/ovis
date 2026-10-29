/**
 * The first-run setup guide (lib/setupGuideFlow.ts): a welcome, then one screen. It checks the PC for
 * coding agents; with one there it offers Start, which opens the first workspace with it, and with
 * none it installs one (AgentSetupCard: the user's one tap runs the official installer, then the
 * agent's sign-in) and then offers Start. Plan usage is turned on for accounts already signed in;
 * the phone and alerts need the user's own steps, so they are links to Settings. It adds no server
 * route. Its layout follows the Claude and Codex apps' first runs: one screen in the main area, the
 * app's sidebar left in place.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Bell, Check, ChevronDown, ChevronRight, FolderOpen, Gauge, Info, LoaderCircle, Play, RotateCw, Smartphone, Sparkles } from "lucide-react";

import type { AgentCatalogEntry, AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { createWorkspace, fetchAgentCatalog, fetchUsage } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { createRequest, newSessionLaunch } from "../lib/newSession.ts";
import { recentDirectories } from "../lib/recent-directories.ts";
import { useSettings } from "../lib/settings.ts";
import { checkList, foundAgents, preferredAgent, settleDelay, setupView, signedInAccounts, startAgents, type CheckStatus, type GuideEvent, type GuideState, type PcCheck } from "../lib/setupGuideFlow.ts";
import { useSignedInUsage } from "../lib/useSetupGuide.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentSetupCard } from "./AgentSetupCard.tsx";
import { DirectoryBrowser, homeRelative } from "./DirectoryBrowser.tsx";
import "./SetupGuide.css";

/** the catalog's agents, named in the check's lines before the PC answers */
type KnownAgent = Pick<AgentCatalogEntry, "id" | "name" | "kind">;
/** the agent the install screen offers first, and the one it offers instead */
const RECOMMENDED = "claude";
const ALTERNATIVE = "codex";
/** where Start opens the first workspace when this browser has no recent folder: the server's home */
const HOME = "~";

export interface SetupGuideProps {
  state: GuideState;
  /** stepped aside for a pane the user went to: kept mounted, so what runs goes on */
  hidden?: boolean;
  dispatch: (event: GuideEvent) => void;
  /** I've used Ovis before, Skip setup, or the first workspace opened */
  onClose: () => void;
  /** shows the tab an install or sign-in runs in */
  onOpenTerminal: (paneId: string) => void;
  /** Connect your phone and Turn on alerts: the Settings page that does it */
  onOpenSettings: (page: "devices" | "alerts") => void;
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
  // an agent the install screen set up that said it is ready: Start, before the PC is read again
  const [ready, setReady] = useState<string | null>(null);
  // said to a screen reader once the screen settles; its heading changes without focus
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
        setAnnounced(foundAgents(answer.agents).length > 0 ? t("You're set up") : t("No AI coding helper on this PC yet"));
      }, settleDelay(startedAt, Date.now()));
    }, (error: unknown) => {
      if (ask !== asked.current) return;
      setCatalogError(userErrorMessage(error).message);
      setChecking(false);
    });
  };
  const onReady = (agent: string): void => {
    setReady(agent);
    setAnnounced(t("You're set up"));
    // read the PC again for the version it now has; Start is there meanwhile
    const ask = ++asked.current;
    fetchAgentCatalog(machineId).then((answer) => { if (ask === asked.current) setCatalog(answer.agents); }, () => { /* Start works without the version */ });
  };
  const begun = state.step !== "welcome";
  useEffect(() => {
    if (begun) loadCatalog();
    return () => { asked.current += 1; window.clearTimeout(settle.current); };
  }, [begun, machineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const check: PcCheck = { checking, catalog, failed: catalogError !== null };
  const view = setupView(check, ready);

  useEffect(() => {
    if (begun && !hidden) document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [begun, hidden]);
  const viewBefore = useRef(view);
  useEffect(() => {
    if (viewBefore.current === view) return;
    viewBefore.current = view;
    // the control that had focus went with the view it was in: the new view's heading takes it
    if (!hidden && (document.activeElement === null || document.activeElement === document.body)) document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [view, hidden]);

  if (state.step === "welcome") return <Welcome dispatch={props.dispatch} onClose={onClose} hidden={hidden} />;
  return (
    <div className="setup-guide" role="region" aria-label={t("Setup guide")} hidden={hidden}>
      <div className="setup-guide-inner">
        <div className="setup-head">
          <span>{t("Set up Ovis")}</span>
          <button type="button" className="setup-link" onClick={onClose}>{t("Skip setup")}</button>
        </div>
        <p className="visually-hidden" role="status">{announced}</p>
        {view === "checking" && <Checking known={known} catalog={catalog} />}
        {view === "found" && <StartScreen agents={startAgents(catalog, ready)} ready={ready} onOpened={props.onOpened} onOpenSettings={props.onOpenSettings} />}
        {view === "none" && <InstallScreen catalog={catalog} catalogError={catalogError} machineId={machineId} onOpenTerminal={props.onOpenTerminal} onReady={onReady} onLookAgain={loadCatalog} />}
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
            <span className="setup-choice-text"><strong>{t("I'm new to Ovis")}</strong><span>{t("Ovis finds or installs an AI coding helper and opens your first project.")}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
          <button type="button" className="setup-choice" onClick={onClose}>
            <span className="setup-choice-icon"><ArrowRight aria-hidden="true" /></span>
            <span className="setup-choice-text"><strong>{t("I've used Ovis before")}</strong><span>{t("Skip the setup and go straight in")}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <p className="setup-note"><Info aria-hidden="true" />{t("You can open this again any time from Settings → Setup guide.")}</p>
      </div>
    </div>
  );
}

function checkLine(t: Translate, status: CheckStatus): ReactNode {
  switch (status.kind) {
    case "looking": return <><LoaderCircle aria-hidden="true" className="agent-setup-spin" /><span className="visually-hidden">{t("Looking")}</span></>;
    case "installed": return <><Check aria-hidden="true" />{status.version === null ? t("Installed") : t("Installed · v{version}", { version: status.version })}</>;
    case "missing": return t("Not installed");
    case "unknown": return t("Can't tell");
  }
}

function Checking({ known, catalog }: { known: readonly KnownAgent[]; catalog: readonly AgentCatalogRow[] | null }) {
  const t = useT();
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
    </section>
  );
}

function StartScreen({ agents, ready, onOpened, onOpenSettings }: { agents: readonly AgentCatalogRow[]; ready: string | null } & Pick<SetupGuideProps, "onOpened" | "onOpenSettings">) {
  const t = useT();
  const { settings, update } = useSettings();
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = agents.find((agent) => agent.id === picked) ?? preferredAgent(agents, ready)!;
  // the plan accounts already signed in here: their usage is turned on as soon as they are seen, without a question
  const signedIn = useSignedInUsage(ready, (refresh) => fetchUsage(refresh).then((report) => signedInAccounts(report.providers)), settings.showUsage, () => update({ showUsage: true }));
  const [folder, setFolder] = useState<string>(() => recentDirectories.read("local")[0] ?? HOME);
  const [browsing, setBrowsing] = useState(false);
  // the folder the browser last said it shows, and how its Use this folder names it: the pick keeps the
  // absolute path for it; any other pick (a home it fell back to, the folder asked for gone) is taken as given
  const shownFolder = useRef<string | null>(null);
  const shownPicked = useRef<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the workspace made, when the agent did not start in it: opening it shows why, in its terminal
  const [madeWithout, setMadeWithout] = useState<string | null>(null);
  const folderName = folder === HOME ? t("your home folder") : basename(folder);

  const start = async (): Promise<void> => {
    if (madeWithout !== null) { onOpened(madeWithout, false); return; }
    if (opening) return;
    setOpening(true);
    setError(null);
    const launch = newSessionLaunch({ agent: chosen.id, model: "", effort: "", prompt: "" }, settings);
    if ("fault" in launch) { setOpening(false); setError(t("{agent} can't start from here. Open a workspace from the sidebar instead.", { agent: chosen.name })); return; }
    try {
      const result = await createWorkspace(createRequest({ tab: null, directory: folder, name: "" }, launch, null));
      if (folder !== HOME) recentDirectories.remember("local", [folder], true);
      if (result.agent_started === false) {
        setOpening(false);
        setMadeWithout(result.pane_id);
        setError(t("The workspace opened, but {agent} did not start. Open it to see why in its terminal.", { agent: chosen.name }) + (result.error?.message ? ` (${result.error.message})` : ""));
        return;
      }
      onOpened(result.pane_id, true);
    } catch (reason: unknown) {
      setOpening(false);
      setError(userErrorMessage(reason).message);
    }
  };

  return (
    <section className="setup-step" aria-labelledby="setup-step-title">
      <div className="setup-done-head">
        <Check aria-hidden="true" />
        <div>
          <h2 id="setup-step-title" tabIndex={-1}>{t("You're set up")}</h2>
          <p className="setup-lead">{agents.length > 1 ? t("Ovis found these on this PC. Start opens your first project with the one picked.") : t("Start opens your first project with it.")}</p>
        </div>
      </div>
      <div className="setup-found" role="group" aria-label={t("Found on this PC")}>
        {agents.map((agent) => (
          <button key={agent.id} type="button" className="setup-found-agent" aria-pressed={agent.id === chosen.id} disabled={opening || madeWithout !== null} onClick={() => setPicked(agent.id)}>
            <AgentMark agent={agent.id} size={20} />
            <span className="setup-found-name"><strong>{agent.name}</strong>{agent.state.version !== null && <span>{agent.state.version}</span>}</span>
            {agent.id === chosen.id && <Check aria-hidden="true" />}
          </button>
        ))}
      </div>
      {signedIn > 0 && <p className="setup-note"><Gauge aria-hidden="true" />{t("Plan usage will show in the sidebar for your signed-in accounts.")}</p>}
      {error !== null && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="btn btn-primary" disabled={opening} onClick={() => void start()}>
          <Play aria-hidden="true" />{madeWithout !== null ? t("Open the workspace") : t("Start with {agent}", { agent: chosen.name })}
        </button>
        {madeWithout === null && (
          <span className="setup-folder-line">
            <FolderOpen aria-hidden="true" /><span title={folder === HOME ? undefined : folder}>{t("in {folder}", { folder: folderName })}</span>
            <button type="button" className="setup-link" aria-expanded={browsing} disabled={opening} onClick={() => setBrowsing((open) => !open)}>{t("Change folder")}</button>
          </span>
        )}
      </div>
      {browsing && <div className="setup-browser"><DirectoryBrowser start={folder === HOME ? "" : folder} onPick={(choice) => { setFolder((shown) => shown !== HOME && shownFolder.current === shown && choice === shownPicked.current ? shown : choice); setBrowsing(false); }} onFolder={(path, home) => { shownFolder.current = path; shownPicked.current = homeRelative(path, home); setFolder(path); }} /></div>}
      <div className="setup-more">
        <button type="button" className="setup-link" onClick={() => onOpenSettings("devices")}><Smartphone aria-hidden="true" />{t("Connect your phone")}</button>
        <button type="button" className="setup-link" onClick={() => onOpenSettings("alerts")}><Bell aria-hidden="true" />{t("Turn on alerts")}</button>
      </div>
    </section>
  );
}

function InstallScreen({ catalog, catalogError, machineId, onOpenTerminal, onReady, onLookAgain }: { catalog: readonly AgentCatalogRow[] | null; catalogError: string | null; machineId: string; onOpenTerminal: (paneId: string) => void; onReady: (agent: string) => void; onLookAgain: () => void }) {
  const t = useT();
  const [choice, setChoice] = useState(RECOMMENDED);
  const [others, setOthers] = useState(false);
  // an install or sign-in under way, or asked for and not answered yet: the agent stays the one it runs for
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = running || pending;
  const row = catalog?.find((agent) => agent.id === choice) ?? null;
  const otherAgents = (catalog ?? []).filter((agent) => agent.kind === "harness" && agent.id !== RECOMMENDED && agent.id !== ALTERNATIVE && agent.install !== null);
  // the link or row picked goes away with the list: the new card's Install takes the focus
  const picked = useRef(false);
  useEffect(() => {
    if (!picked.current) return;
    picked.current = false;
    document.querySelector<HTMLButtonElement>(".setup-guide .agent-setup .btn-primary")?.focus();
  }, [choice]);
  const pick = (id: string): void => { picked.current = true; setChoice(id); setOthers(false); };
  const instead = (catalog ?? []).find((agent) => agent.id === (choice === RECOMMENDED ? ALTERNATIVE : RECOMMENDED) && agent.install !== null);
  if (catalog === null) {
    return (
      <section className="setup-step" aria-labelledby="setup-step-title">
        <h2 id="setup-step-title" tabIndex={-1}>{t("Couldn't check this PC")}</h2>
        {catalogError !== null && <p className="setup-error" role="alert">{catalogError}</p>}
        <div className="setup-actions">
          <button type="button" className="btn btn-primary" onClick={onLookAgain}><RotateCw aria-hidden="true" />{t("Look again")}</button>
        </div>
      </section>
    );
  }
  return (
    <section className="setup-step" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title" tabIndex={-1}>{t("No AI coding helper on this PC yet")}</h2>
      <p className="setup-lead">{t("Install one to start: Ovis runs its official installer on this PC, then opens its sign-in. Nothing is installed until you tap Install.")}</p>
      {row !== null && (
        <>
          {choice === RECOMMENDED && <p className="setup-label">{t("Recommended")}</p>}
          <AgentSetupCard key={row.id} agent={row} machineId={machineId} autoSignIn onOpenTerminal={onOpenTerminal} onStart={() => onReady(row.id)}
            onPending={setPending} onStep={(step) => { setRunning(step.kind !== "idle" && step.kind !== "failed"); if (step.kind === "ready") onReady(row.id); }} />
        </>
      )}
      {!busy && (
        <div className="setup-more">
          {instead !== undefined && <button type="button" className="setup-link" onClick={() => pick(instead.id)}>{t("Use {agent} instead", { agent: instead.name })}</button>}
          {otherAgents.length > 0 && (
            <button type="button" className="setup-link" aria-expanded={others} onClick={() => setOthers((open) => !open)}>
              {others ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{t("Other agents ({count})", { count: otherAgents.length })}
            </button>
          )}
        </div>
      )}
      {others && !busy && (
        <ul className="setup-others-list">
          {otherAgents.map((agent) => (
            <li key={agent.id}>
              <button type="button" className="setup-other" aria-pressed={agent.id === choice} onClick={() => pick(agent.id)}><AgentMark agent={agent.id} size={18} /><span>{agent.name}</span></button>
            </li>
          ))}
        </ul>
      )}
      {!busy && (
        <div className="setup-actions">
          <span className="setup-muted">{t("Already installed one?")}</span>
          <button type="button" className="btn btn-ghost" onClick={onLookAgain}><RotateCw aria-hidden="true" />{t("Look again")}</button>
        </div>
      )}
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
