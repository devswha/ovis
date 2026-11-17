import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { ApiError } from "./api.ts";
import { answerFromText, answerRefusal, needsConfirmation, type TypedAnswer } from "./promptAnswer.ts";
import { composerDelivery, pendingActionUncertain, submitNote, submitNotTyped, submitRefusal, type DraftRefusal } from "./compose.ts";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";
import { pendingMessages, UNCONFIRMED_SEND } from "./pendingMessages.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { rememberWaitingSend, stampedBaseline, waitingBaseline, waitingKey } from "./sentWaiting.ts";
import { composerDrafts } from "./composerDraft.ts";
import type { AgentStatus, InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import type { HerdrSocket, SubmitDelivery, SubmitResult } from "./ws.ts";
import { plainError } from "./paneTerminalShared.ts";
import type { Translate } from "./i18n.ts";
import type { MachineSession } from "./machineSession.ts";

export interface ComposerSendsDeps {
  agent: string | null;
  agentStatus: AgentStatus | undefined;
  answerPanePrompt: (answer: { pane_id: string; prompt_id: string }) => Promise<unknown>;
  answering: InteractivePrompt | null;
  answerPending: boolean;
  draftHeldForRef: MutableRefObject<string | null>;
  ended: boolean;
  heldByOpenQueue: boolean;
  heldRef: MutableRefObject<boolean>;
  inputRowNow: () => string | null;
  inputAtRest?: () => boolean;
  knownOutcomes: (pane: string | null) => readonly string[] | null;
  observeRef: MutableRefObject<boolean>;
  paneId: string | null;
  paneRef: MutableRefObject<string | null>;
  pendingAnswer: { pane: string; promptId: string; answer: TypedAnswer } | null;
  pendingScopeRef: MutableRefObject<string | null>;
  chatNavigation: MutableRefObject<number>;
  setChatLocalSend: (update: (current: { key: number; navigationGeneration: number }) => { key: number; navigationGeneration: number }) => void;
  sessionRef: MutableRefObject<MachineSession | null>;
  queueOwner: string | null;
  queueStore: unknown;
  machineId: string;
  secretRef: MutableRefObject<string | null>;
  setPendingAnswer: (answer: { pane: string; promptId: string; answer: Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text"> } | null) => void;
  setPromptRefresh: (update: (key: number) => number) => void;
  settings: { autoSendQueued: boolean };
  showSentCommand: (pane: string, text: string, known: readonly string[] | null, seen: boolean) => void;
  socketRef: MutableRefObject<HerdrSocket | null>;
  stillOpenNote: (open: { pane: string; agent: string; command: string; named: boolean; history: string | undefined }) => string;
  stillOpenNotedRef: MutableRefObject<boolean>;
  stillOpenRef: MutableRefObject<{ pane: string; agent: string; command: string; named: boolean; history: string | undefined } | null>;
  submitComposerMessage: (text: string, delivery: SubmitDelivery, clearDraft?: string, sendAnyway?: boolean, pendingId?: string, resendGeneration?: number, agentOnly?: boolean, holdOnly?: boolean) => Promise<SubmitResult> | null;
  submitRetention: PaneSubmitRetention | null;
  t: Translate;
}

export function useComposerSends(deps: ComposerSendsDeps) {
  const { agent, agentStatus, answerPanePrompt, answering, answerPending, chatNavigation, draftHeldForRef, ended, heldByOpenQueue, heldRef, inputAtRest, inputRowNow, knownOutcomes, observeRef, paneId, paneRef, pendingAnswer, pendingScopeRef, queueOwner, queueStore, machineId, secretRef, sessionRef, setChatLocalSend, setPendingAnswer, setPromptRefresh, settings, showSentCommand, socketRef, stillOpenNote, stillOpenNotedRef, stillOpenRef, submitComposerMessage, submitRetention, t } = deps;

  const sendAnswer = useCallback((pane: string, prompt: InteractivePrompt, choice: TypedAnswer): Promise<boolean | string> => {
    setPendingAnswer(null);
    return answerPanePrompt({ pane_id: pane, prompt_id: prompt.id, ...choice }).then(
      () => { setPromptRefresh((key) => key + 1); return true; },
      (cause: unknown) => {
        setPromptRefresh((key) => key + 1);
        if (cause instanceof ApiError && cause.code === "reply_unconfirmed") return t("OpenCode did not confirm the answer. Check the question before sending again.");
        return cause instanceof ApiError && cause.status === 409 ? t("The question on screen changed; check it and answer again.") : plainError(cause);
      },
    );
  }, [answerPanePrompt, setPendingAnswer, setPromptRefresh, t]);

  const waitingAnswer = useMemo(() => {
    if (answerPending || paneId === null || answering === null || pendingAnswer === null || pendingAnswer.pane !== paneId || pendingAnswer.promptId !== answering.id) return null;
    const pane = paneId, choice = pendingAnswer.answer;
    return {
      confirm: (): Promise<boolean | string> => sendAnswer(pane, answering, choice),
      cancel: (): void => setPendingAnswer(null),
    };
  }, [answering, answerPending, paneId, pendingAnswer, sendAnswer, setPendingAnswer]);

  const sendNowRef = useRef<(id: string) => Promise<void>>(async () => {});

  const composerSend = useCallback(
    (text: string, clearDraft?: string, sendAnyway = false, agentOnly = false, now = false, hold = false): boolean | string | DraftRefusal | Promise<boolean | string | DraftRefusal> => {
      const pane = paneRef.current;
      if (pane !== null && answerPending) return false;
      if (pane !== null && heldByOpenQueue) {
        return t("Codex has a question open in the terminal: answer it above, or close it there (alt+↓) to message Codex.");
      }
      const asDraft = clearDraft !== undefined && text === clearDraft;
      if (pane !== null && asDraft && answering !== null) return submitNote("agent_blocked", "");
      if (pane !== null && answering !== null && !hold) {
        const choice = answerFromText(answering, text);
        if (choice === null) return answerRefusal(answering);
        if (needsConfirmation(answering, choice)) {
          setPendingAnswer({ pane, promptId: answering.id, answer: choice });
          return true;
        }
        return sendAnswer(pane, answering, choice);
      }
      if (!socketRef.current?.connected || heldRef.current || secretRef.current !== null) return false;
      const notedStillOpen = stillOpenNotedRef.current;
      stillOpenNotedRef.current = false;
      const open = stillOpenRef.current;
      if (sendAnyway && notedStillOpen) sendAnyway = false;
      else if (!sendAnyway && !hold && open !== null && open.pane === pane) {
        stillOpenNotedRef.current = true;
        return { note: stillOpenNote(open), anyway: true, plain: true };
      }
      // herdr reads an idle Claude with a live subagent as working (a braille title spinner, and
      // "Waiting for N background agents to finish"); its own box at rest says it can take the message
      const settled = composerDelivery(agent, agentStatus);
      const queued = settled === "queue" && inputAtRest?.() === true ? "immediate" : settled;
      const delivery: SubmitDelivery = hold ? "hold" : queued === "queue" && !settings.autoSendQueued ? "hold" : queued;
      if ((sendAnyway || asDraft) && delivery !== "immediate") return t("Not sent: the agent started working since. Check the terminal, then send again.");
      const known = knownOutcomes(pane);
      const seen = inputRowNow() === "ready";
      const navigation = chatNavigation.current;
      const socket = socketRef.current, session = sessionRef.current;
      const sentAt = Date.now();
      const sentAfter = pane === null ? null : waitingBaseline(waitingKey(machineId, pane));
      const result = submitComposerMessage(text, delivery, delivery === "immediate" ? clearDraft : undefined, sendAnyway, undefined, undefined, agentOnly, hold);
      return result === null ? false : result.then((answer) => {
        if (!answer.ok) return submitRefusal(answer.code, answer.message, answer.draft, answer.box, agent);
        if (answer.unconfirmed && pane !== null) pendingMessages.keepUnconfirmed(paneStorageId(machineId, pane), text);
        const typedNow = answer.pending === undefined && !answer.unconfirmed && (delivery === "immediate" || answer.typedNow === true);
        if (typedNow) {
          if (paneRef.current === pane && socketRef.current === socket && sessionRef.current === session) {
            setChatLocalSend((current) => ({ key: current.key + 1, navigationGeneration: navigation }));
          }
          if (pane !== null) rememberWaitingSend(waitingKey(machineId, pane), text, sentAt, stampedBaseline(sentAfter, answer.sendingAt, sentAt));
        }
        if (pane !== null && typedNow) showSentCommand(pane, text, known, seen);
        if (now && answer.pending !== undefined) void sendNowRef.current(answer.pending.id);
        return true;
      });
    },
    [agent, agentStatus, answering, answerPending, heldByOpenQueue, sendAnswer, submitComposerMessage, queueStore, machineId, settings.autoSendQueued, showSentCommand, inputAtRest, inputRowNow, stillOpenNote],
  );

  const actOnPending = useCallback(async (id: string, action: "steer" | "discard" | "edit"): Promise<void> => {
    const perform = async (): Promise<void> => {
      const owner = queueOwner, pane = paneId;
      const socket = socketRef.current, scope = pendingScopeRef.current;
      if (owner === null || pane === null || paneRef.current !== pane) return;
      pendingMessages.refresh(owner);
      const message = pendingMessages.read(owner).find((item) => item.id === id);
      if (!message || message.state === "sending") return;
      if (action === "edit" && (!message.serverOwned || message.state !== "queued" && message.state !== "held" || message.resendInFlight)) return;
      if (action === "steer" && (message.state === "uncertain" || !socket?.connected || heldRef.current || secretRef.current !== null || observeRef.current || ended || heldByOpenQueue || answering !== null)) return;
      if (message.serverOwned && !pendingMessages.isOwned(owner, id, scope)) return;
      if (action === "steer" && draftHeldForRef.current === pane) {
        pendingMessages.fail(owner, id, { code: "held_input", message: "send or discard the held input first" }, false);
        return;
      }
      const open = stillOpenRef.current;
      if (action === "steer" && open !== null && open.pane === pane) {
        pendingMessages.fail(owner, id, { code: "still_open", message: stillOpenNote(open) }, false);
        return;
      }
      if (!pendingMessages.begin(owner, id)) return;
      try {
        if (message.serverOwned) {
          let delivered = false, edited = false;
          const off = socket?.on((frame) => {
            if (frame.type !== "pending-messages" || frame.pane_id !== pane) return;
            if (frame.removed?.some((item) => item.id === id && item.outcome === "sent")) delivered = true;
            if (action === "edit" && !edited && frame.removed?.some((item) => item.id === id && item.outcome === "discarded")) {
              edited = true;
              composerDrafts.restorePending(`ovis:composer-draft:${owner}`, message.text, message.agent_only === true);
            }
          });
          try {
            const known = knownOutcomes(pane);
            const seen = inputRowNow() === "ready";
            const result = socket?.pendingAction(pane, id, action === "edit" ? "discard" : action, message.resendGeneration ?? 0, action === "edit");
            if (!result) {
              pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, pendingActionUncertain("not_transmitted", message.state));
              return;
            }
            const releaseSubmit = submitRetention?.retain(pane);
            const answer = await result.finally(() => releaseSubmit?.());
            if (answer.ok && action === "steer" && delivered) showSentCommand(pane, message.text, known, seen);
            if (!answer.ok) pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, pendingActionUncertain(answer.code, message.state),
              action === "steer" ? message.resendGeneration ?? 0 : undefined);
          } finally {
            off?.();
          }
        } else if (action === "discard") {
          pendingMessages.removeCopy(owner, id);
        } else if (message.state === "held") {
          if (!pendingMessages.unconfirm(owner, id)) {
            return;
          }
          const known = knownOutcomes(pane);
          const seen = inputRowNow() === "ready";
          const sentAt = Date.now(), sentAfter = waitingBaseline(waitingKey(machineId, pane));
          const result = submitComposerMessage(message.text, "immediate", undefined, false, id, message.resendGeneration ?? 0, message.agent_only === true);
          if (!result) {
            pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, false);
            return;
          }
          const answer = await result;
          if (answer.ok && answer.unconfirmed) pendingMessages.fail(owner, id, UNCONFIRMED_SEND, true, message.resendGeneration ?? 0);
          else if (answer.ok) {
            pendingMessages.removeCopy(owner, id);
            if (answer.pending === undefined) {
              if (answer.typedNow === true) rememberWaitingSend(waitingKey(machineId, pane), message.text, sentAt, stampedBaseline(sentAfter, answer.sendingAt, sentAt));
              showSentCommand(pane, message.text, known, seen);
            }
          }
          else if (answer.code === "pending_discarded") pendingMessages.removeCopy(owner, id);
          else pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, !submitNotTyped(answer.code), message.resendGeneration ?? 0);
        }
      } catch {
        pendingMessages.fail(owner, id, { code: "disconnected", message: t("Not confirmed. Check the terminal before sending again.") }, true);
      } finally { pendingMessages.end(owner, id); }
    };
    // Web Locks reduce contention where supported; the bridge's stable resend ID is the
    // authority on LAN HTTP and when two tabs have already read the same held copy.
    if (navigator.locks) await navigator.locks.request(`pending:${queueOwner}:${id}`, perform);
    else await perform();
  }, [answering, ended, heldByOpenQueue, paneId, queueOwner, submitComposerMessage, submitRetention, showSentCommand, inputRowNow, stillOpenNote]);

  sendNowRef.current = (id) => actOnPending(id, "steer");

  return { composerSend, actOnPending, waitingAnswer };
}
