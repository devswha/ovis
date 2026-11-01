import { closeSync } from "node:fs";
import { createHash } from "node:crypto";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { HistoryChanged, answerVersion, type ConversationPage, type RecognizedConversation } from "./conversation-shared.ts";
import { resolveAgent } from "./pane-context.ts";
import { assertManagedGjcCurrent, resolveManagedGjcSession, type ManagedGjcBinding, type ManagedGjcDeps } from "./managed-gjc-session.ts";
import { declaresManagedGjc, ManagedGjcProofFailure, openManagedGjcTranscript } from "./managed-gjc-record.ts";

export interface PaneConversationDeps {
  readonly snapshot?: () => Promise<SessionSnapshot>;
  readonly managedGjc?: ManagedGjcDeps;
}

export interface ManagedGjcTranscript {
  readonly source: "gjc-transcript";
  readonly path: string;
  readonly managedGjc: ManagedGjcBinding;
}

/** The native tool id remains bounded separately from the manager binding prefix. */
export const MANAGED_GJC_TOOL_REF = /^managed-[0-9a-f]{32}-[1-9][0-9]{0,15}:[0-9a-f]{64}:[A-Za-z0-9_:.-]{1,128}$/;

export async function resolveManagedGjcTranscript(pane: HerdrPane, deps: ManagedGjcDeps = {}): Promise<ManagedGjcTranscript | null> {
  if (!declaresManagedGjc(pane)) return null;
  const managed = await resolveManagedGjcSession(pane, deps);
  if (managed?.state === "ready") {
    return { source: "gjc-transcript", path: managed.binding.evidence.record.sessionFile, managedGjc: managed.binding };
  }
  if (managed !== null) throw new ManagedGjcProofFailure(managed.reason);
  if (resolveAgent(pane).agent === "gjc") throw new ManagedGjcProofFailure("blocked_managed_record_unavailable");
  return null;
}

function prefix(binding: ManagedGjcBinding): string {
  return `managed-${binding.identity.id}-${binding.identity.generation}:`;
}

function attachmentPrefix(binding: ManagedGjcBinding): string {
  const { sessionId } = binding.identity;
  const { dev, ino } = binding.evidence.record.fileIdentity;
  const digest = createHash("sha256").update(JSON.stringify([sessionId, dev, ino, binding.evidence.record.sessionFile])).digest("hex");
  return `${prefix(binding)}${digest}:`;
}

function unwrappedPage(page: ConversationPage, binding: ManagedGjcBinding): ConversationPage {
  const historyPrefix = prefix(binding);
  if (page.history_id !== undefined && !page.history_id.startsWith(historyPrefix)) throw new HistoryChanged();
  const unwrap = (cursor: string | undefined): string | undefined => {
    if (cursor === undefined) return undefined;
    if (!cursor.startsWith(historyPrefix) || cursor.length === historyPrefix.length) throw new HistoryChanged();
    return cursor.slice(historyPrefix.length);
  };
  return { before: unwrap(page.before), since: unwrap(page.since), from: unwrap(page.from), prompts: page.prompts };
}

function bindAnswer(answer: RecognizedConversation, page: ConversationPage, binding: ManagedGjcBinding): RecognizedConversation {
  const historyPrefix = prefix(binding);
  const refPrefix = attachmentPrefix(binding);
  const pageKey = `${page.before ?? ""}\0${page.since ?? ""}\0${page.from ?? ""}`;
  return {
    ...answer,
    history_id: `${historyPrefix}${answer.history_id}`,
    cursor: answer.cursor === null ? null : `${historyPrefix}${answer.cursor}`,
    version: answerVersion(`${historyPrefix}${pageKey}`, `${binding.identity.sessionId}\0${answer.version}`),
    turns: answer.turns.map(turn => ({
      ...turn,
      parts: turn.parts.map(part => part.kind === "image" ? { ...part, ref: `${refPrefix}${part.ref}` }
        : part.kind === "tool" ? {
          ...part,
          ...(part.output_ref === undefined ? {} : { output_ref: `${refPrefix}${part.output_ref}` }),
          ...(part.images === undefined ? {} : { images: part.images.map(image => ({ ...image, ref: `${refPrefix}${image.ref}` })) }),
        } : part),
    })),
  };
}

export async function managedGjcConversation(
  pane: HerdrPane,
  page: ConversationPage,
  binding: ManagedGjcBinding,
  deps: ManagedGjcDeps = {},
  readPage: (page: ConversationPage, fd: number) => RecognizedConversation,
): Promise<RecognizedConversation> {
  const internalPage = unwrappedPage(page, binding);
  const fd = openManagedGjcTranscript(binding.evidence);
  let answer: RecognizedConversation;
  try {
    answer = readPage(internalPage, fd);
  } catch (error) {
    await assertManagedGjcCurrent(pane, binding, deps);
    throw error;
  } finally { closeSync(fd); }
  await assertManagedGjcCurrent(pane, binding, deps);
  return bindAnswer(answer, internalPage, binding);
}

export async function managedGjcToolOutput(
  pane: HerdrPane,
  ref: string,
  binding: ManagedGjcBinding,
  deps: ManagedGjcDeps = {},
  readOutput: (nativeRef: string, fd: number) => string | null,
): Promise<string | null> {
  const refPrefix = attachmentPrefix(binding);
  if (!ref.startsWith(refPrefix)) return null;
  const fd = openManagedGjcTranscript(binding.evidence);
  try {
    const output = readOutput(ref.slice(refPrefix.length), fd);
    await assertManagedGjcCurrent(pane, binding, deps);
    return output;
  } finally { closeSync(fd); }
}
