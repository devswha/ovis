import { useEffect, useMemo, useRef, useState } from "react";
import { ChartColumn, X } from "lucide-react";

import { type TelemetryStatus } from "../../shared/telemetry.ts";
import { NOTICE_VERSION } from "../../shared/telemetry-notice.ts";
import { ApiError, changeTelemetry, fetchTelemetry } from "../lib/api.ts";
import { telemetrySettingsSnapshot, useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver } from "../lib/useFocusTrap.ts";
import { SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

const heardGeneration = (status: TelemetryStatus | null | undefined): { generation?: number } =>
  status?.counts_generation === undefined ? {} : { generation: status.counts_generation };
export function TelemetryNotice({ enabled, onOpen, inline = false }: { enabled: boolean; onOpen: () => void; inline?: boolean }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [closed, setClosed] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [offFailed, setOffFailed] = useState(false);
  const turnedOff = useRef(false);
  // The server keeps this browser's latest safe settings snapshot for its next count. The snapshot
  // contains no raw user-entered values or account identifiers.
  const { settings } = useSettings();
  const settingsSnapshot = useMemo(() => telemetrySettingsSnapshot(settings), [settings]);
  const settingsSignature = JSON.stringify(settingsSnapshot);
  const settingsSnapshotRef = useRef(settingsSnapshot);
  settingsSnapshotRef.current = settingsSnapshot;
  const submittedSettingsSignature = submittedNotice;
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [, offHeard] = useState(0);
  useEffect(() => {
    const heard = (): void => offHeard((count) => count + 1);
    noticeOff.listeners.add(heard);
    return () => { noticeOff.listeners.delete(heard); };
  }, []);
  const allowed = status !== null && status.enabled && !status.blocked_by_env && status.notice_seen && !noticeOff.current;
  useEffect(() => {
    if (!enabled || !allowed || submittedSettingsSignature.current === settingsSignature) return;
    submittedSettingsSignature.current = settingsSignature;
    changeTelemetry({ settings: settingsSnapshot, ...heardGeneration(status) }).then((next) => { if (!turnedOff.current) setStatus(next); }, (error: unknown) => {
      if (!(error instanceof ApiError && error.status === 404)) console.error("telemetry settings", error);
    });
  }, [enabled, allowed, settingsSignature, settingsSnapshot]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchTelemetry().then((current) => {
      if (!live || !current) return;
      setStatus(current);
      if ((!current.notice_seen || noticeShownHere.current) && current.enabled && !current.blocked_by_env && !noticeOff.current) { noticeShownHere.current = true; setShown(true); }
    }, (error: unknown) => console.error("telemetry status", error));
    return () => { live = false; };
  }, [enabled]);
  const [line, setLine] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!shown || !enabled || line === null) return;
    let recorded = false;
    let failures = 0;
    let frame = 0;
    let inView = typeof IntersectionObserver === "undefined";
    // two frames after the commit the line has been painted; a hidden tab paints nothing
    const afterPaint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(record); });
    };
    const record = () => {
      if (recorded || noticeRecorded.current || document.visibilityState !== "visible" || !inView || coveredByModal(line)) return;
      recorded = true;
      noticeRecorded.current = true;
      const snapshot = settingsSnapshotRef.current;
      changeTelemetry({
        notice_seen: true,
        notice_version: NOTICE_VERSION,
        settings: snapshot,
        ...heardGeneration(statusRef.current),
      }).then((next) => { submittedSettingsSignature.current = JSON.stringify(snapshot); if (!turnedOff.current) setStatus(next); },
        (error: unknown) => {
          const retryable = !(error instanceof ApiError) || error.status >= 500;
          noticeRecorded.current = !retryable;
          console.error("telemetry notice", error);
          failures += 1;
          if (retryable && failures < 3) recorded = false;
        });
    };
    const onVisibility = () => { if (document.visibilityState === "visible") afterPaint(); };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      inView = entry !== undefined && entry.isIntersecting && entry.intersectionRatio >= 0.99;
      if (inView) afterPaint();
    }, { threshold: [0, 1] });
    observer?.observe(line);
    afterPaint();
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusin", afterPaint);
    return () => { recorded = true; cancelAnimationFrame(frame); observer?.disconnect(); document.removeEventListener("visibilitychange", onVisibility); document.removeEventListener("focusin", afterPaint); };
  }, [shown, enabled, line]);
  if (!shown || closed || !enabled || (noticeOff.current && !offFailed)) return null;
  const turnOff = () => {
    turnedOff.current = true;
    setTurningOff(true);
    setOffFailed(false);
    changeTelemetry({ enabled: false }).then((next) => {
      setStatus(next); setClosed(true);
      noticeOff.current = true;
      for (const heard of noticeOff.listeners) heard();
    }, (error: unknown) => {
      console.error("telemetry off", error);
      turnedOff.current = false;
      setTurningOff(false);
      setOffFailed(true);
      setClosed(false);
    });
  };
  const text = offFailed ? t("Couldn't turn the counts off. Open Settings to use the switch.") : t("Button use and other anonymous usage counts are sent to improve Ovis.");
  if (inline) return <p ref={setLine} className="setup-note setup-note-usage" role={offFailed ? "alert" : "status"}>
    <ChartColumn aria-hidden="true" />
    <button type="button" className="setup-link" aria-haspopup="dialog" onClick={onOpen}>{text}</button>
    <button type="button" className="btn btn-ghost setup-note-off" disabled={turningOff} onClick={turnOff}>{t("Turn off")}</button>
  </p>;
  return <div ref={setLine} className="update-notice is-line is-telemetry" role={offFailed ? "alert" : "status"}>
    <button type="button" className="update-notice-text" title={text} aria-haspopup="dialog" onClick={() => { setClosed(true); onOpen(); }}>{text}</button>
    <button type="button" className="btn btn-ghost" disabled={turningOff} onClick={turnOff}>{t("Turn off")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => setClosed(true)}><X /></button>
  </div>;
}

const submittedNotice: { current: string | null } = { current: null };
const noticeShownHere = { current: false };
const noticeRecorded = { current: false };
const noticeOff = { current: false, listeners: new Set<() => void>() };

function coveredByModal(node: HTMLElement): boolean {
  // a native showModal() dialog (Add PC) covers it too, though it carries no aria-modal (#3882)
  return nativeModalOver(node) || [...document.querySelectorAll<HTMLElement>("[aria-modal='true']")].some((modal) => !modal.contains(node) && modal.getClientRects().length > 0);
}

const FIELDS_HELP = "https://github.com/devswha/ovis/blob/main/docs/guide.md#anonymous-usage-counts";

export function TelemetryControls() {
  const t = useT();
  const { settings } = useSettings();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const settingsSnapshot = useMemo(() => telemetrySettingsSnapshot(settings), [settings]);
  const settingsSignature = JSON.stringify(settingsSnapshot);
  const settingsSnapshotRef = useRef(settingsSnapshot);
  settingsSnapshotRef.current = settingsSnapshot;
  const statusRequest = useRef(0);
  useEffect(() => {
    let live = true;
    const request = ++statusRequest.current;
    const snapshot = settingsSnapshotRef.current;
    setError(null);
    fetchTelemetry().then((current) => {
      if (!live || request !== statusRequest.current) return;
      if (!current) {
        setStatus(null);
        return;
      }
      if (!current.enabled || current.blocked_by_env || !current.notice_seen) {
        setStatus(current);
        return;
      }
      return changeTelemetry({ settings: snapshot, ...heardGeneration(current) }).then((next) => {
        if (!live || request !== statusRequest.current) return;
        setStatus(next);
      });
    }).catch((failure: unknown) => {
      if (!live || request !== statusRequest.current) return;
      if (failure instanceof ApiError && failure.status === 404) {
        setStatus(null);
        setError(null);
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    });
    return () => { live = false; };
  }, [settingsSignature]);
  if (!status) return error ? <p className="settings-item settings-hint" role="alert">{error}</p> : null;
  const toggle = (enabled: boolean) => {
    if (saving) return;
    const request = ++statusRequest.current;
    setSaving(true);
    setError(null);
    changeTelemetry(enabled ? { enabled, settings: settingsSnapshotRef.current, ...heardGeneration(status) } : { enabled }).then(
      (next) => {
        if (request === statusRequest.current) setStatus(next);
        if (enabled && noticeOff.current) { noticeOff.current = false; for (const heard of noticeOff.listeners) heard(); }
      },
      (failure: unknown) => { if (request === statusRequest.current) setError(failure instanceof Error ? failure.message : String(failure)); },
    ).finally(() => setSaving(false));
  };
  return (
    <SettingsGroup title={t("Anonymous usage counts")} className="settings-telemetry" section="telemetry">
      {status.blocked_by_env
        ? <SettingsRow label={t("Send anonymous usage counts")} icon={ChartColumn} description={t("Turned off on this PC by OVIS_TELEMETRY=0, DO_NOT_TRACK or a CI environment.")}>
          <span className="settings-fact" role="status">{t("Off")}</span>
        </SettingsRow>
        : <SettingsRow label={t("Send anonymous usage counts")} icon={ChartColumn} description={t("Once on install and once per update, with the last browser's app settings, and once a day you open the app, with the kinds of coding agents running in herdr (such as claude or codex), the kinds of screen the app was opened on, how they reached this PC, and how many prompt answers were sent and alerts delivered and tapped. After each day, how often the app's buttons were used that day (chat sends, the composer's buttons, the agent inbox, and switches between chat and terminal by kind of agent and how) and, for a few actions, whether a button, a menu, a shortcut or the command palette was used, each count only as a rough range, with the list of which of these controls were shown, on narrow and wide screens apart, never what was typed, which pane or what time of day. Custom fonts, shortcuts and replies are reported only as customization flags or counts, never their text. Account identifiers, terminal content and files are excluded. The receiver stores the country, not the IP address.")}>
          <Toggle label={t("Send anonymous usage counts")} checked={status.enabled} onChange={toggle} disabled={saving} />
        </SettingsRow>}
      {error && <p className="settings-item settings-hint" role="alert">{error}</p>}
      <details className="settings-item">
        <summary>{t("What is sent")}</summary>
        {status.next
          ? <pre className="update-output">{JSON.stringify(status.next, null, 2)}</pre>
          : <p className="settings-hint">{t("This version has already been counted. The next event is sent after an update.")}</p>}
        <p className="settings-hint">{t("Once a day you open the app:")}</p>
        <pre className="update-output">{JSON.stringify(status.active, null, 2)}</pre>
        {status.counts && <>
          <p className="settings-hint">{t("After a day has ended:")}</p>
          <pre className="update-output">{JSON.stringify(status.counts, null, 2)}</pre>
        </>}
        <p className="settings-hint">{t("The receiver adds the country this message comes from (two letters, such as KR). It does not store the address.")}</p>
        <a className="settings-link" href={FIELDS_HELP} target="_blank" rel="noreferrer">{t("What each field means")}</a>
      </details>
    </SettingsGroup>
  );
}
