/**
 * The pane's scheduled messages (#2919), above its queued ones: each with its time or why it has not gone, and Send
 * now, Edit and Discard. The PC keeps them, so every device that drives it shows the same list; it is read again
 * whenever the PC says it changed, and on every connect.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUp, Clock, Pencil, X } from "lucide-react";
import type { ScheduledMessage } from "../../shared/protocol.ts";
import { discardScheduled, fetchScheduled, sendScheduledNow, updateScheduled, ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { scheduledStatus } from "../lib/sendLater.ts";
import type { HerdrSocket } from "../lib/ws.ts";
import { SendLaterDialog } from "./SendLaterDialog.tsx";
import "./PendingMessages.css";
import "./SendLaterDialog.css";

/** The PC's scheduled messages, read again on its word; empty where the PC keeps none or this connection may not drive. */
export function useScheduledMessages(machineId: string, socket: HerdrSocket | null, enabled: boolean): ScheduledMessage[] {
  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  useEffect(() => {
    if (!enabled || socket === null) { setMessages([]); return; }
    let live = true;
    let generation = 0;
    const load = (): void => {
      const mine = ++generation;
      void fetchScheduled(machineId).then((next) => { if (live && mine === generation) setMessages(next); }, () => {});
    };
    load();
    const off = socket.on((message) => { if (message.type === "scheduled-changed" || message.type === "features") load(); });
    return () => { live = false; off(); };
  }, [enabled, machineId, socket]);
  return messages;
}

interface Props {
  machineId: string;
  messages: ScheduledMessage[];
  connected: boolean;
}

export function ScheduledMessages({ machineId, messages, connected }: Props) {
  const t = useT();
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const [now, setNow] = useState(() => new Date());
  // the rows say "Sends 14:30" until that minute, then why it waits: the clock moves on with them
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const act = useCallback(async (id: string, deed: () => Promise<void>) => {
    setBusy(id);
    setFailure(null);
    try { await deed(); }
    catch (error) { setFailure({ id, text: error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(null); }
  }, []);
  if (messages.length === 0 && editing === null) return null;
  return <>
    <ol className="pending-messages scheduled-messages" aria-label={t("Scheduled messages")}>
      {messages.map((message) => {
        const sending = busy === message.id || message.state === "sending";
        const uncertain = message.state === "uncertain";
        return <li key={message.id} className="pending-message" data-state={message.state}>
          <div className="pending-message-bubble" aria-busy={sending || undefined}>{message.text}</div>
          <div className="pending-message-meta">
            <Clock className="scheduled-message-icon" aria-hidden="true" />
            <span className="pending-message-note" role="status">{scheduledStatus(message, now, t)}</span>
            {!uncertain && <button type="button" className="icon-button pending-message-action pending-message-send"
              aria-label={`${t("Send now")}: ${message.text}`} title={t("Send now")} disabled={!connected || sending}
              onClick={() => void act(message.id, () => sendScheduledNow(message.id, machineId))}>
              <ArrowUp aria-hidden="true" /><span>{t("Send now")}</span>
            </button>}
            {!uncertain && <button type="button" className="icon-button pending-message-action"
              aria-label={`${t("Edit scheduled message")}: ${message.text}`} title={t("Edit scheduled message")} disabled={!connected || sending}
              onClick={() => setEditing(message)}><Pencil aria-hidden="true" /></button>}
            <button type="button" className="icon-button pending-message-action" aria-label={`${t("Discard")}: ${message.text}`} title={t("Discard")}
              disabled={!connected || sending} onClick={() => void act(message.id, () => discardScheduled(message.id, machineId))}><X aria-hidden="true" /></button>
          </div>
          {failure?.id === message.id && <p className="pending-message-note" role="alert">{failure.text}</p>}
        </li>;
      })}
    </ol>
    {editing && <SendLaterDialog title={t("Edit scheduled message")} text={editing.text} sendAt={editing.send_at} planReset={null} submitLabel={t("Save")}
      onSubmit={async (text, sendAt) => { await updateScheduled(editing.id, { text, sendAt }, machineId); setEditing(null); }}
      onClose={() => setEditing(null)} />}
  </>;
}
