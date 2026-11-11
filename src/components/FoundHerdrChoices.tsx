import type { FoundHerdrSession, FoundOvis, SshTarget } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";

export type HerdrChoice = Pick<SshTarget, "session" | "herdr_socket" | "start_new_herdr" | "own_ovis">;

/** A fresh choice to make (this PC's Ovis or running herdr sessions were found), not what was chosen being gone or refused */
export function asksChoice(sessions: readonly FoundHerdrSession[], ownOvis: readonly FoundOvis[], refused: boolean): boolean {
  return ownOvis.length > 0 || !refused && sessions.length > 0;
}

/** The same choice on a saved PC's card and on a first setup that has no card yet. */
/** `coreRefusal`: why the Ovis chosen for this PC could not be used (gone, or its socket refused), in the UI language */
export function FoundHerdrChoices({ sessions, ownOvis = [], coreRefusal, busy, onChoose }: { sessions: FoundHerdrSession[]; ownOvis?: FoundOvis[]; coreRefusal?: string; busy: boolean; onChoose(choice: HerdrChoice): void }) {
  const t = useT();
  // a question is drawn as one (is-setup); only what was chosen and is gone or refused is drawn as a failure
  const question = asksChoice(sessions, ownOvis, !!coreRefusal);
  return <div className={`machine-action${question ? " is-setup" : ""}`} role="status">
    {/* the PC's own Ovis, where its sessions are, is the first and main answer; the herdr sessions running beside it,
        which it does not serve, follow under their own line, and starting a new herdr comes last */}
    {ownOvis.length > 0 && <p className="machine-action-text"><strong>{t("Ovis on this PC (herdr-core)")}</strong></p>}
    {ownOvis.map((found) => <div className="machine-own-address" key={found.socket_path}>
      <code>{found.socket_path}</code>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onChoose({ own_ovis: found.socket_path, herdr_socket: undefined, start_new_herdr: undefined })}>{t("Use Ovis on this PC (herdr-core)")}</button>
    </div>)}
    {/* none listed: the session chosen for this PC stopped, and no other one runs there */}
    {ownOvis.length ? sessions.length > 0 && <p className="machine-action-text"><span>{t("Or a herdr session running on this PC")}</span></p> : coreRefusal ? <p className="machine-action-text"><strong>{coreRefusal}</strong></p> : sessions.length ? <p className="machine-action-text"><strong>{t("A herdr session is already running on this PC")}</strong><span>{t("Choose the session to use, or start a new herdr here.")}</span></p>
      : <p className="machine-action-text"><strong>{t("The chosen herdr session is no longer running")}</strong><span>{t("Start it on that PC and reconnect, or start a new herdr here.")}</span></p>}
    {sessions.map((found) => <div className="machine-own-address" key={found.socket_path}>
      <span>{found.session ?? t("Default session")}</span>
      <code>{found.socket_path}</code>
      <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ session: found.session, herdr_socket: found.socket_path, start_new_herdr: undefined, own_ovis: undefined })}>{t("Use {label}", { label: found.session ?? t("Default session") })}</button>
    </div>)}
    <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ herdr_socket: undefined, start_new_herdr: true, own_ovis: undefined })}>{t("Start a new herdr here")}</button>
  </div>;
}
