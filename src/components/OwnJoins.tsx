import { useEffect, useId, useState, type FormEvent } from "react";

import type { OwnJoinRequest } from "../../shared/machines.ts";
import { ApiError, approveOwnJoin, fetchOwnJoins } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { ADDED_POLL_MS } from "./AccountSection.tsx";

/**
 * Account joins no pairing window invited, listed in this PC's own window only (server/relay/routes.ts, /api/relay/joins):
 * nothing pops up, and the owner lets one in by typing the digits its screen shows. A wrong number ends that join.
 */
export function OwnJoins() {
  const t = useT();
  const [joins, setJoins] = useState<OwnJoinRequest[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checks, setChecks] = useState(0);
  const id = useId();
  useEffect(() => {
    let live = true;
    let refused = false;
    const read = (): void => {
      if (refused || document.hidden) return;
      fetchOwnJoins().then((next) => { if (live) setJoins(next); }, (error: unknown) => {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 405)) refused = true;
        else console.warn("Ovis: the account joins could not be read", error instanceof Error ? error.name : error);
      });
    };
    read();
    const timer = setInterval(read, ADDED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [checks]);

  const approve = (join: OwnJoinRequest) => (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("digits") as HTMLInputElement | null;
    setProblem(null);
    approveOwnJoin(join.id, (field?.value ?? "").replace(/\s/g, "")).then(() => setOpen(null), (error: unknown) => {
      setProblem(error instanceof ApiError && error.code === "wrong_digits"
        ? t("That is not the number {name} shows. It was not let in; it can ask again.", { name: join.label })
        : t("{name} is no longer waiting.", { name: join.label }));
      setOpen(null);
    }).finally(() => setChecks((count) => count + 1));
  };

  if (joins.length === 0 && problem === null) return null;
  return (
    <div className="settings-item own-joins" data-testid="own-joins">
      {joins.map((join) => (
        <div key={join.id} className="settings-row" data-join={join.id}>
          <span className="settings-label">{t("A device of your account asks to join")}
            <span className="settings-description"> · {join.label} · {lastSeen(join.asked_at, Date.now())}</span>
          </span>
          {open === join.id ? (
            <form className="relay-shell-code-form" onSubmit={approve(join)}>
              <label className="field-label" htmlFor={`${id}-${join.id}`}>{t("Number on {name}", { name: join.label })}</label>
              <input id={`${id}-${join.id}`} name="digits" className="input relay-shell-code-input" inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="one-time-code" required autoFocus />
              <button type="submit" className="btn btn-primary">{t("Approve")}</button>
              <button type="button" className="btn" onClick={() => setOpen(null)}>{t("Cancel")}</button>
            </form>
          ) : (
            <button type="button" className="btn" onClick={() => { setProblem(null); setOpen(join.id); }}>{t("Type the number")}</button>
          )}
        </div>
      ))}
      {problem !== null && <p className="settings-condition" role="alert">{problem}</p>}
    </div>
  );
}
