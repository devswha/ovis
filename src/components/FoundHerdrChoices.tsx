import type { FoundHerdrSession, FoundOvis, SshTarget } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { machineErrorText } from "../lib/userError.ts";

export type HerdrChoice = Pick<SshTarget, "session" | "herdr_socket" | "start_new_herdr" | "own_ovis">;

const FRESH_CHOICE = new Set(["Choose this PC's Ovis server or a running herdr session.", "A herdr session is already running on this PC. Choose it, or start a new one."]);

export function asksChoice(error: string | null | undefined, sessions: readonly FoundHerdrSession[], ownOvis: readonly FoundOvis[]): boolean {
  return (!error || FRESH_CHOICE.has(error)) && (ownOvis.length > 0 || sessions.length > 0);
}

/** A choice's socket, drawn only where another choice would read the same. */
const where = (path: string, shared: boolean) => shared && <code className="machine-choice-path">{path}</code>;

/** The running herdr sessions and a new one: the answer only where no Ovis runs; beside one they wait under Advanced settings. */
export function HerdrSessionChoices({ sessions, busy, onChoose }: { sessions: FoundHerdrSession[]; busy: boolean; onChoose(choice: HerdrChoice): void }) {
  const t = useT();
  const shared = (session?: string) => sessions.filter((other) => other.session === session).length > 1;
  return <div className="machine-action-buttons">
    {sessions.map((found) => <button key={found.socket_path} type="button" className="btn" title={found.socket_path} disabled={busy} onClick={() => onChoose({ session: found.session, herdr_socket: found.socket_path, start_new_herdr: undefined, own_ovis: undefined })}>{t("Use {label}", { label: found.session ?? t("Default session") })}{where(found.socket_path, shared(found.session))}</button>)}
    <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ herdr_socket: undefined, start_new_herdr: true, own_ovis: undefined })}>{t("Start a new herdr here")}</button>
  </div>;
}

/** `foldedAbove`: beside an Ovis, the sessions are in the dialog's own Advanced settings, so none are drawn here. */
export function FoundHerdrChoices({ sessions, ownOvis = [], error, busy, onChoose, foldedAbove = false }: { sessions: FoundHerdrSession[]; ownOvis?: FoundOvis[]; error?: string | null; busy: boolean; onChoose(choice: HerdrChoice): void; foldedAbove?: boolean }) {
  const t = useT();
  const question = asksChoice(error, sessions, ownOvis);
  const reason = !question && error ? machineErrorText(error, t) : null;
  const herdrChoices = <HerdrSessionChoices sessions={sessions} busy={busy} onChoose={onChoose} />;
  return <div className={`machine-action${question ? " is-setup" : ""}`} role="status">
    {reason !== null && <p className="machine-action-text"><strong>{reason}</strong></p>}
    {ownOvis.map((found) => <button key={found.socket_path} type="button" className={question ? "btn btn-primary" : "btn"} title={found.socket_path} disabled={busy} onClick={() => onChoose({ own_ovis: found.socket_path, herdr_socket: undefined, start_new_herdr: undefined })}>{t("Use Ovis on this PC (herdr-core)")}{where(found.socket_path, ownOvis.length > 1)}</button>)}
    {ownOvis.length ? !foldedAbove && <details className="machine-action-more"><summary>{t("Advanced settings")}</summary>{herdrChoices}</details> : <>
      {reason === null && (sessions.length ? <p className="machine-action-text"><strong>{t("A herdr session is already running on this PC")}</strong><span>{t("Choose the session to use, or start a new herdr here.")}</span></p>
        : <p className="machine-action-text"><strong>{t("The chosen herdr session is no longer running")}</strong><span>{t("Start it on that PC and reconnect, or start a new herdr here.")}</span></p>)}
      {herdrChoices}
    </>}
  </div>;
}
