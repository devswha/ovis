/**
 * Send later (#2919): the message and the time the PC sends it, as a mail app's Schedule send offers it: a few
 * times to pick at once, or any time in the field below them, and When this plan limit resets where the pane's
 * agent reports one. The PC keeps it from here on, so it goes with every device closed.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "./ConfirmDialog.css";
import "./SendLaterDialog.css";

import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { localInputValue, parseLocalInput, quickTimes, sendTimeLabel } from "../lib/sendLater.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

interface Props {
  title: string;
  text: string;
  /** the time it is set for now (an edit); a new one starts an hour from now */
  sendAt?: string;
  /** when the pane's plan limit resets, where its agent reports one */
  planReset: Date | null;
  submitLabel: string;
  /** resolves once the PC keeps it; the owner then takes the dialog down */
  onSubmit: (text: string, sendAt: string) => Promise<void>;
  onClose: () => void;
}

export function SendLaterDialog({ title, text: initialText, sendAt, planReset, submitLabel, onSubmit, onClose }: Props) {
  const t = useT();
  const id = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: textRef, shouldRestore: () => !done.current });
  const [pending, setPending] = useState(false);
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  const [now] = useState(() => new Date());
  const quick = quickTimes(now);
  const [text, setText] = useState(initialText);
  const [when, setWhen] = useState(() => localInputValue(sendAt ? new Date(sendAt) : quick.inHour));
  const [error, setError] = useState<string | null>(null);
  // drawn again when a send finds its time passed, so the note below says so
  const [, redraw] = useState(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);

  const at = parseLocalInput(when);
  const choices = [
    { label: t("In 1 hour"), at: quick.inHour },
    { label: t("Tomorrow at 9:00"), at: quick.tomorrowMorning },
    ...(planReset ? [{ label: t("When this plan limit resets ({time})", { time: sendTimeLabel(planReset.toISOString(), now) }), at: planReset }] : []),
  ];
  const empty = text.trim().length === 0;
  // a time already past is never saved: it would go at once, and a held message would go without its Send now
  const past = at !== null && at.getTime() <= Date.now();

  const submit = async (): Promise<void> => {
    // read again as it is sent: a dialog left open can pass the time it shows (#2951)
    if (at === null || empty || at.getTime() <= Date.now()) { redraw((count) => count + 1); return; }
    setPending(true);
    setError(null);
    try { await onSubmit(text, at.toISOString()); done.current = true; }
    catch (reason: unknown) {
      setError(reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal send-later-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{title}</h2></header>
        <form className="send-later-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="modal-body send-later-body">
          <label className="send-later-label" htmlFor={`${id}-text`}>{t("Message")}</label>
          <textarea ref={textRef} id={`${id}-text`} className="input send-later-text" rows={3} value={text} disabled={pending}
            onChange={(event) => setText(event.target.value)} />
          <div className="send-later-choices" role="group" aria-label={t("Send at")}>
            {choices.map((choice) => {
              const value = localInputValue(choice.at);
              return <button key={choice.label} type="button" className="send-later-choice" aria-pressed={value === when} disabled={pending}
                onClick={() => setWhen(value)}>{choice.label}</button>;
            })}
          </div>
          <label className="send-later-label" htmlFor={`${id}-when`}>{t("Send at")}</label>
          <input id={`${id}-when`} className="input send-later-when" type="datetime-local" value={when} required disabled={pending}
            onChange={(event) => setWhen(event.target.value)} />
          {past && <p className="confirm-error" role="status">{t("Pick a time that has not passed yet.")}</p>}
          <p className="send-later-note">{t("This PC keeps it and sends it at that time while a device has this pane open; otherwise it waits until one does. It waits for the agent's turn to end, and is not sent if the pane is gone or runs another session.")}</p>
          {error && <p className="confirm-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={pending || at === null || empty || past}>{submitLabel}</button>
        </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
