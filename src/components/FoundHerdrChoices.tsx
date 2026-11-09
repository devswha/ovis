import type { FoundHerdrSession, FoundOvis, SshTarget } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";

export type HerdrChoice = Pick<SshTarget, "session" | "herdr_socket" | "start_new_herdr" | "own_ovis">;

/** The same choice on a saved PC's card and on a first setup that has no card yet. */
export function FoundHerdrChoices({ sessions, ownOvis = [], coreUnavailable = false, busy, onChoose }: { sessions: FoundHerdrSession[]; ownOvis?: FoundOvis[]; coreUnavailable?: boolean; busy: boolean; onChoose(choice: HerdrChoice): void }) {
  const t = useT();
  return <div className="machine-action" role="status">
    {/* none listed: the session chosen for this PC stopped, and no other one runs there */}
    {ownOvis.length ? <p className="machine-action-text"><strong>{t("Ovis on this PC (herdr-core)")}</strong><span>{t("Choose the session to use, or start a new herdr here.")}</span></p> : coreUnavailable ? <p className="machine-action-text"><strong>{t("Start Ovis on that PC, or start a new herdr here")}</strong></p> : sessions.length ? <p className="machine-action-text"><strong>{t("A herdr session is already running on this PC")}</strong><span>{t("Choose the session to use, or start a new herdr here.")}</span></p>
      : <p className="machine-action-text"><strong>{t("The chosen herdr session is no longer running")}</strong><span>{t("Start it on that PC and reconnect, or start a new herdr here.")}</span></p>}
    {sessions.map((found) => <div className="machine-own-address" key={found.socket_path}>
      <span>{found.session ?? t("Default session")}</span>
      <code>{found.socket_path}</code>
      <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ session: found.session, herdr_socket: found.socket_path, start_new_herdr: undefined, own_ovis: undefined })}>{t("Use {label}", { label: found.session ?? t("Default session") })}</button>
    </div>)}
    {ownOvis.map((found) => <div className="machine-own-address" key={found.socket_path}>
      <code>{found.socket_path}</code>
      <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ own_ovis: found.socket_path, herdr_socket: undefined, start_new_herdr: undefined })}>{t("Use Ovis on this PC (herdr-core)")}</button>
    </div>)}
    <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ herdr_socket: undefined, start_new_herdr: true, own_ovis: undefined })}>{t("Start a new herdr here")}</button>
  </div>;
}
