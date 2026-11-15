/**
 * The Fleet screen (todo 33 of the relay-fleet plan; DESIGN.md "Fleet screen"): what needs the owner first (a held
 * fleet, slots on hold, batches waiting for confirmation), then the machine list, the invites not used yet and the
 * form that mints more. Who sees which control follows the route table of todo 30 (lib/fleet.ts fleetOwner): an owner
 * gets Download invites, Confirm and Remove; a watching device reads the same lists without them. While the fleet is
 * held for want of OVIS_TOKEN no write is offered at all. An invite's secret never reaches the screen: a mint goes
 * straight into one downloaded archive.
 *
 * Todo 31 adds, where the seams below say: the rolled-back notice with its own Confirm and the "Removed after this
 * backup" marks with Re-admit, Release on a slot on hold, and the retention a batch is minted with.
 */
import "./FleetView.css";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { HealthAuth } from "../../shared/access.ts";
import { FLEET_CAUSE_SENTENCE } from "../../shared/fleet-cause.ts";
import type { FleetMachineRow } from "../../shared/fleet-cause.ts";
import { ApiError } from "../lib/api.ts";
import { confirmFleetBatch, fetchFleet, fleetOwner, fleetStateWord, mintFleetInvites, removeFleetMachine } from "../lib/fleet.ts";
import type { FleetBatch, FleetData, FleetInvite } from "../lib/fleet.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { StatusDot } from "./StatusDot.tsx";
import type { StatusDotState } from "./StatusDot.tsx";

/** How often the open screen reads the fleet again, as the PC list's roster does. */
const REFRESH_MS = 5_000;
/** From this many machines on, only the rows in view (and a margin) are drawn. */
export const FLEET_WINDOW_FROM = 60;
const OVERSCAN_ROWS = 8;
/** Rows drawn before the list has measured its scroller (and in a renderer without layout). */
const FIRST_WINDOW = 40;
const LIVES = [3600, 6 * 3600, 24 * 3600] as const;

type Translate = ReturnType<typeof useT>;

function dotOf(machine: FleetMachineRow): StatusDotState {
  if (machine.state === "quarantined") return "failed";
  if (machine.state === "pending") return "needs-you";
  if (machine.state === "revoked" || !machine.online || machine.cause === "fleet_token_required") return "offline";
  return machine.cause === null ? "ready" : "needs-you";
}

function causeLine(machine: FleetMachineRow, t: Translate): string {
  if (machine.cause !== null) return t(FLEET_CAUSE_SENTENCE[machine.cause]);
  return machine.warnings.map((warning) => t(FLEET_CAUSE_SENTENCE[warning])).join(" ");
}

const atTime = (ms: number): string => new Date(ms).toLocaleString();

/** Whether `element` took the focus by keyboard: the browser draws its ring then (`:focus-visible`), never for a click or a tap. */
function byKeyboard(element: Element): boolean {
  try { return element.matches(":focus-visible"); } catch { return true; }
}

/** Which rows of `count` are in view of `scroller`, for a list whose rows all have one height. */
function useRowWindow(count: number, scroller: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>): { start: number; end: number; rowHeight: number } {
  const windowed = count >= FLEET_WINDOW_FROM;
  const [view, setView] = useState({ start: 0, end: Math.min(count, FIRST_WINDOW), rowHeight: 0 });
  useLayoutEffect(() => {
    if (!windowed) return;
    const body = scroller.current;
    const host = list.current;
    if (!body || !host) return;
    let frame = 0;
    let rowHeight = view.rowHeight;
    const measure = (): void => {
      frame = 0;
      rowHeight = host.querySelector<HTMLElement>(".fleet-row")?.offsetHeight || rowHeight;
      if (rowHeight === 0) return;
      const top = host.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
      const from = body.scrollTop - top;
      const start = Math.min(count, Math.max(0, Math.floor(from / rowHeight) - OVERSCAN_ROWS));
      const end = Math.min(count, Math.max(start, Math.ceil((from + body.clientHeight) / rowHeight) + OVERSCAN_ROWS));
      setView((before) => before.start === start && before.end === end && before.rowHeight === rowHeight ? before : { start, end, rowHeight });
    };
    const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
    measure();
    body.addEventListener("scroll", schedule, { passive: true });
    const resized = new ResizeObserver(schedule);
    resized.observe(body);
    return () => { body.removeEventListener("scroll", schedule); resized.disconnect(); if (frame !== 0) cancelAnimationFrame(frame); };
  }, [windowed, count, scroller, list, view.rowHeight]);
  return windowed ? { ...view, end: Math.min(view.end, count) } : { start: 0, end: count, rowHeight: 0 };
}

function MachineRow({ machine, position, size, now, canRemove, onRemove }: { machine: FleetMachineRow; position: number; size: number; now: number; canRemove: boolean; onRemove(machine: FleetMachineRow): void }) {
  const t = useT();
  const cause = causeLine(machine, t);
  const route = machine.route === "direct" ? t("Direct") : machine.route === "relay" ? t("Relay") : null;
  const seen = machine.online ? t("Now") : machine.last_seen === null ? null : lastSeen(new Date(machine.last_seen).toISOString(), now);
  return (
    <li className="fleet-row" data-fleet-state={machine.state} data-machine-id={machine.machine_id} aria-setsize={size} aria-posinset={position}>
      <span className="fleet-row-name">
        <StatusDot state={dotOf(machine)} />
        <span className="fleet-row-label" title={machine.name}>{machine.name}</span>
      </span>
      <span className="fleet-row-fingerprint fleet-fingerprint" title={t("Key fingerprint")}>{machine.fingerprint}</span>
      <span className="fleet-row-state"><span className="fleet-state-word">{fleetStateWord(machine, t)}</span></span>
      <span className="fleet-row-cause" title={cause || undefined}>{cause}</span>
      <span className="fleet-row-route" data-empty={route === null ? "" : undefined}><span className="visually-hidden">{t("Route")}: </span>{route ?? "—"}</span>
      <span className="fleet-row-seen" data-empty={seen === null ? "" : undefined} title={seen === null ? t("Not seen since this PC's Ovis started") : machine.last_seen === null ? undefined : atTime(machine.last_seen)}>
        <span className="visually-hidden">{t("Last seen")}: </span>{seen ?? "—"}
      </span>
      <span className="fleet-row-act">
        {canRemove && machine.state !== "revoked" && <button type="button" className="btn fleet-row-remove" aria-label={t("Remove {name}", { name: machine.name })} onClick={() => onRemove(machine)}>{t("Remove")}</button>}
      </span>
    </li>
  );
}

/**
 * The machine list. The dialog's focus trap moves the focus without scrolling (lib/useFocusTrap.ts), and only the rows in
 * view are drawn, so the list follows the focus itself: a focused row is scrolled into view, which moves the window and
 * draws the rows next to it. Tab coming in from above starts at the first row, and Shift+Tab coming back from below starts
 * at the last, even when those rows were not drawn: the scroller goes there and the focus follows once they are. Only
 * keyboard focus is sent there: a click or a tap focuses the button it lands on (not :focus-visible), and moving the list
 * under it would lose the click.
 */
function MachineList({ machines, now, canRemove, scroller, onRemove }: { machines: readonly FleetMachineRow[]; now: number; canRemove: boolean; scroller: RefObject<HTMLElement | null>; onRemove(machine: FleetMachineRow): void }) {
  const t = useT();
  const list = useRef<HTMLUListElement>(null);
  const { start, end, rowHeight } = useRowWindow(machines.length, scroller, list);
  /** The row (0-based) whose Remove takes the focus once it is drawn. */
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = pending.current;
    if (index === null || index < start || index >= end) return;
    pending.current = null;
    list.current?.querySelector<HTMLElement>(`.fleet-row[aria-posinset="${index + 1}"] .fleet-row-remove`)?.focus();
  }, [start, end]);
  const onFocus = (event: FocusEvent<HTMLUListElement>): void => {
    const row = event.target.closest<HTMLElement>(".fleet-row");
    const host = list.current;
    const body = scroller.current;
    if (!row || !host || !body) return;
    const from = event.relatedTarget;
    if (from instanceof Node && !host.contains(from) && rowHeight > 0 && byKeyboard(event.target)) {
      const after = (host.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const target = after ? machines.length - 1 : 0;
      if (Number(row.getAttribute("aria-posinset")) - 1 !== target) {
        const top = host.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
        pending.current = target;
        body.scrollTop = after ? top + (target + 1) * rowHeight - body.clientHeight : top + target * rowHeight;
        return;
      }
    }
    row.scrollIntoView({ block: "nearest" });
  };
  const padding = rowHeight === 0 ? undefined : { paddingTop: start * rowHeight, paddingBottom: (machines.length - end) * rowHeight };
  return (
    <>
      <div className="fleet-list-head" aria-hidden="true">
        <span>{t("Name")}</span><span>{t("State")}</span><span>{t("Route")}</span><span>{t("Last seen")}</span><span />
      </div>
      <ul ref={list} className="fleet-list" aria-label={t("Machine list")} style={padding} onFocus={onFocus}>
        {machines.slice(start, end).map((machine, index) => (
          <MachineRow key={machine.machine_id} machine={machine} position={start + index + 1} size={machines.length} now={now} canRemove={canRemove} onRemove={onRemove} />
        ))}
      </ul>
    </>
  );
}

function BatchCard({ batch, canConfirm, busy, primary, onConfirm }: { batch: FleetBatch; canConfirm: boolean; busy: boolean; primary: boolean; onConfirm(batch: FleetBatch): void }) {
  const t = useT();
  return (
    <div className="fleet-batch" data-batch-id={batch.batch_id}>
      <p className="fleet-batch-head">
        <span className="fleet-batch-count">{batch.count === 1 ? t("1 machine joined") : t("{n} machines joined", { n: batch.count })}</span>
        <span className="fleet-batch-id">{t("Batch {id}", { id: batch.batch_id })}</span>
      </p>
      <ol className="fleet-batch-machines" aria-label={t("Machines of batch {id}", { id: batch.batch_id })}>
        {batch.machines.map((machine) => (
          <li key={machine.machine_id}>
            <span className="fleet-batch-name">{machine.name}</span>
            <span className="fleet-fingerprint">{machine.fingerprint}</span>
          </li>
        ))}
      </ol>
      {canConfirm && (
        <button type="button" className={primary ? "btn btn-primary fleet-confirm" : "btn fleet-confirm"} disabled={busy} onClick={() => onConfirm(batch)}>
          {batch.count === 1 ? t("Confirm 1 machine") : t("Confirm {n} machines", { n: batch.count })}
        </button>
      )}
    </div>
  );
}

/** The invites not used yet, by batch: how many, their names, and until when they work. */
function UnusedInvites({ invites, now }: { invites: readonly FleetInvite[]; now: number }) {
  const t = useT();
  const batches = new Map<string, FleetInvite[]>();
  for (const invite of invites) if (invite.state !== "used") batches.set(invite.batch_id, [...batches.get(invite.batch_id) ?? [], invite]);
  if (batches.size === 0) return <p className="fleet-quiet">{t("Every invite was used.")}</p>;
  return (
    <ul className="fleet-invites">
      {[...batches].map(([batchId, open]) => {
        const exp = Math.max(...open.map((invite) => invite.exp)) * 1000;
        const expired = open.every((invite) => invite.state === "expired");
        return (
          <li key={batchId} className="fleet-invite-batch" data-batch-id={batchId}>
            <span className="fleet-invite-head">
              {open.length === 1 ? t("1 invite not used") : t("{n} invites not used", { n: open.length })}
              <span aria-hidden="true"> · </span>
              <time dateTime={new Date(exp).toISOString()} title={atTime(exp)}>{expired ? t("expired {when}", { when: lastSeen(new Date(exp).toISOString(), now) }) : t("valid until {time}", { time: atTime(exp) })}</time>
            </span>
            <span className="fleet-invite-names">{open.map((invite) => invite.name).join(", ")}</span>
          </li>
        );
      })}
    </ul>
  );
}

function MintForm({ primary, onMinted }: { primary: boolean; onMinted(): void }) {
  const t = useT();
  const id = useId();
  const [count, setCount] = useState("1");
  const [prefix, setPrefix] = useState("vm-");
  const [life, setLife] = useState<number>(LIVES[0]);
  const lifeLabel = (seconds: number): string => seconds === 3600 ? t("1 hour") : seconds === 6 * 3600 ? t("6 hours") : t("24 hours");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const amount = Number(count);
  const valid = Number.isInteger(amount) && amount >= 1 && amount <= 256;
  const mint = async (): Promise<void> => {
    setBusy(true); setDone(null); setError(null);
    try {
      const minted = await mintFleetInvites({ count: amount, prefix, life_s: life });
      const url = URL.createObjectURL(new Blob([minted.archive], { type: "application/zip" }));
      minted.archive.fill(0);
      const link = document.createElement("a");
      link.href = url;
      link.download = minted.fileName;
      link.click();
      // the download holds its own copy; the address is dropped once the browser has taken it
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDone(t("{n} invites saved as {file}. Each works once, until {time}.", { n: minted.count, file: minted.fileName, time: atTime(minted.exp * 1000) }));
      onMinted();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="fleet-mint" onSubmit={(event) => { event.preventDefault(); if (valid && !busy) void mint(); }}>
      <div className="fleet-mint-fields">
        <label className="field" htmlFor={`${id}-count`}>
          <span className="field-label">{t("Machines")}</span>
          <input id={`${id}-count`} className="input" type="number" inputMode="numeric" min={1} max={256} value={count} onChange={(event) => setCount(event.target.value)} />
        </label>
        <label className="field" htmlFor={`${id}-prefix`}>
          <span className="field-label">{t("Name prefix")}</span>
          <input id={`${id}-prefix`} className="input" type="text" value={prefix} maxLength={32} autoComplete="off" spellCheck={false} onChange={(event) => setPrefix(event.target.value)} />
        </label>
        <label className="field" htmlFor={`${id}-life`}>
          <span className="field-label">{t("Invites work for")}</span>
          <select id={`${id}-life`} className="select" value={life} onChange={(event) => setLife(Number(event.target.value))}>
            {LIVES.map((seconds) => <option key={seconds} value={seconds}>{lifeLabel(seconds)}</option>)}
          </select>
        </label>
        {/* seam for todo 31: the batch's retention (how long a machine not seen stays listed) is chosen here */}
      </div>
      <p className="fleet-quiet">{t("One file per machine, in one archive. Each file is a secret that lets one machine join: hand it only to that machine.")}</p>
      <button type="submit" className={primary ? "btn btn-primary" : "btn"} disabled={!valid || busy}>{t("Download invites")}</button>
      {done !== null && <p className="fleet-status" role="status">{done}</p>}
      {error !== null && <p className="fleet-error" role="alert">{error}</p>}
    </form>
  );
}

export function FleetView({ auth, onClose, now: fixedNow }: { auth: HealthAuth | null; onClose(): void; /** a fixed clock for tests */ now?: number }) {
  const t = useT();
  const titleId = useId();
  const owner = fleetOwner(auth);
  const [data, setData] = useState<FleetData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  const [removing, setRemoving] = useState<FleetMachineRow | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const surface = useFocusTrap<HTMLElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  const readAgain = useCallback(() => setReads((count) => count + 1), []);

  useEffect(() => {
    let live = true;
    let timer = 0;
    fetchFleet().then((next) => { if (live) { setData(next); setLoadError(null); } }, (reason: unknown) => {
      if (live) setLoadError(reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (live) timer = window.setTimeout(readAgain, REFRESH_MS); });
    return () => { live = false; window.clearTimeout(timer); };
  }, [reads, readAgain]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || removing !== null) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, removing]);

  const confirm = async (batch: FleetBatch): Promise<void> => {
    setConfirming(batch.batch_id); setNote(null);
    try {
      await confirmFleetBatch(batch);
      setNote({ text: batch.count === 1 ? t("1 machine confirmed.") : t("{n} machines confirmed.", { n: batch.count }), alert: false });
    } catch (reason) {
      const text = reason instanceof ApiError && reason.code === "batch_changed" ? t("The batch changed since it was shown. Check its machines again, then confirm.")
        : reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);
      setNote({ text, alert: true });
    } finally {
      setConfirming(null);
      readAgain();
    }
  };

  const now = fixedNow ?? Date.now();
  const held = data?.held === true;
  const canWrite = owner && !held;
  const listed = (data?.machines ?? []).filter((machine) => machine.state !== "revoked");
  const removed = (data?.machines.length ?? 0) - listed.length;
  const onHold = listed.filter((machine) => machine.state === "quarantined");
  const batches = data?.batches ?? [];
  const mintFirst = data !== null && listed.length === 0 && batches.length === 0;
  const mint = canWrite && data !== null && (
    <section className="fleet-section" aria-labelledby={`${titleId}-mint`}>
      <h3 className="fleet-section-title" id={`${titleId}-mint`}>{t("Invite machines")}</h3>
      <MintForm primary={batches.length === 0} onMinted={readAgain} />
    </section>
  );

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={surface} className="modal fleet-view" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={titleId}>{t("Fleet")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close fleet")} title={t("Close fleet")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div ref={body} className="modal-body fleet-view-body">
          {loadError !== null && (
            <div className="fleet-error-block" role="alert">
              <p className="fleet-error">{t("The fleet could not be read: {reason}", { reason: loadError })}</p>
              <button type="button" className="btn" onClick={readAgain}>{t("Try again")}</button>
            </div>
          )}
          {data === null && loadError === null && <p className="fleet-quiet" role="status">{t("Reading the fleet…")}</p>}
          {held && (
            <div className="fleet-notice" role="status" data-fleet-held="">
              <p>{t(FLEET_CAUSE_SENTENCE.fleet_token_required)}</p>
              <p>{t("Set OVIS_TOKEN on this PC to a long random value (for example from openssl rand -hex 32), then restart Ovis. The machines sign in again with no new invite.")}</p>
            </div>
          )}
          {/* seam for todo 31: while the controller is rolled back, its notice, the list with "Removed after this backup" marks, Re-admit and one Confirm go here */}
          {data !== null && !owner && <p className="fleet-quiet" data-fleet-watching="">{t("This device only watches: it reads the fleet, and the owner invites, confirms and removes machines.")}</p>}
          {note !== null && <p className={note.alert ? "fleet-error" : "fleet-status"} role={note.alert ? "alert" : "status"}>{note.text}</p>}
          {onHold.length > 0 && (
            <div className="fleet-notice fleet-on-hold" role="alert">
              {onHold.map((machine) => (
                <div key={machine.machine_id} className="fleet-on-hold-row" data-machine-id={machine.machine_id}>
                  <p>
                    <strong>{machine.slot === null ? machine.name : t("{name} (slot {slot})", { name: machine.name, slot: machine.slot })}</strong>
                    {" "}{t(FLEET_CAUSE_SENTENCE.quarantined)}
                  </p>
                  {/* seam for todo 31: Release goes beside Remove */}
                  {canWrite && <button type="button" className="btn" aria-label={t("Remove {name}", { name: machine.name })} onClick={() => setRemoving(machine)}>{t("Remove")}</button>}
                </div>
              ))}
            </div>
          )}
          {batches.length > 0 && (
            <section className="fleet-section" aria-labelledby={`${titleId}-batches`}>
              <h3 className="fleet-section-title" id={`${titleId}-batches`}>{t("Waiting for confirmation")}</h3>
              {batches.map((batch, index) => <BatchCard key={batch.batch_id} batch={batch} canConfirm={canWrite} busy={confirming !== null} primary={index === 0} onConfirm={(shown) => void confirm(shown)} />)}
            </section>
          )}
          {mintFirst && mint}
          {data !== null && (
            <section className="fleet-section" aria-labelledby={`${titleId}-machines`}>
              <h3 className="fleet-section-title" id={`${titleId}-machines`}>{t("Machines")} <span className="fleet-count">{listed.length}</span></h3>
              {listed.length === 0 ? <p className="fleet-quiet">{t("No machine has joined yet.")}</p>
                : <MachineList machines={listed} now={now} canRemove={canWrite} scroller={body} onRemove={setRemoving} />}
              {removed > 0 && <p className="fleet-quiet">{removed === 1 ? t("1 removed machine stays refused.") : t("{n} removed machines stay refused.", { n: removed })}</p>}
            </section>
          )}
          {data !== null && data.invites.length > 0 && (
            <section className="fleet-section" aria-labelledby={`${titleId}-invites`}>
              <h3 className="fleet-section-title" id={`${titleId}-invites`}>{t("Invites")}</h3>
              <UnusedInvites invites={data.invites} now={now} />
            </section>
          )}
          {!mintFirst && mint}
        </div>
      </section>
      {removing !== null && (
        <ConfirmDialog title={t("Remove {name} from the fleet?", { name: removing.name })}
          body={t("Its key is refused from now on and its connection ends. Programs keep running on the machine. Adding it again takes a new invite.")}
          confirmLabel={t("Remove")} onClose={() => setRemoving(null)}
          onConfirm={async () => { await removeFleetMachine(removing.machine_id); setRemoving(null); readAgain(); }} />
      )}
    </div>,
    document.body,
  );
}
