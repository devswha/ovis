import type { AgentStatus } from "../../shared/protocol.ts";

export interface BlankChat {
  loaded: boolean;
  failed: boolean;
  transcript: boolean;
  turns: number;
  older: boolean;
  abandoned: number;
  prompt: boolean;
  agent: string | null;
}

export function chatIsBlank(chat: BlankChat): boolean {
  return chat.loaded && !chat.failed && chat.transcript && chat.agent !== null
    && chat.turns === 0 && !chat.older && chat.abandoned === 0 && !chat.prompt;
}

export interface ChatRead {
  blank: boolean;
  turns: number;
  history: string | undefined;
}

export interface GreetingMemory {
  blank: boolean;
  history: string | null;
  sent: boolean;
  pending: number;
}

export const NO_MEMORY: GreetingMemory = { blank: false, history: null, sent: false, pending: 0 };

export function afterRead(memory: GreetingMemory, read: ChatRead | null): GreetingMemory {
  if (read === null) return memory.blank ? { ...memory, blank: false } : memory;
  const history = read.history ?? memory.history ?? "";
  const moved = memory.history !== null && memory.history !== history;
  const sent = memory.sent && read.turns === 0 && !moved;
  return memory.blank === read.blank && memory.history === history && memory.sent === sent ? memory : { ...memory, blank: read.blank, history, sent };
}

export function afterSend(memory: GreetingMemory): GreetingMemory {
  return { ...memory, pending: memory.pending + 1 };
}

export function afterSettled(memory: GreetingMemory, typed: boolean, history: string | null): GreetingMemory {
  const pending = memory.pending > 0 ? memory.pending - 1 : 0;
  const sent = memory.sent || (typed && (history === null || memory.history === history));
  return memory.pending === pending && memory.sent === sent ? memory : { ...memory, sent, pending };
}

const remembered = new Map<string, GreetingMemory>();

export function greetingMemory(owner: string): GreetingMemory {
  return remembered.get(owner) ?? NO_MEMORY;
}

export function rememberGreeting(owner: string, memory: GreetingMemory): void {
  if (memory === NO_MEMORY) remembered.delete(owner);
  else remembered.set(owner, memory);
}

export interface GreetingState {
  memory: GreetingMemory;
  agentStatus: AgentStatus | undefined;
  queued: number;
  folder: string;
}

export function showsGreeting(state: GreetingState): boolean {
  return state.memory.blank && !state.memory.sent && state.memory.pending === 0
    && state.agentStatus !== "blocked"
    && state.queued === 0 && state.folder !== "";
}

export function greetingFolder(cwd: string | null | undefined): string {
  if (!cwd) return "";
  const separator = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(cwd) ? /[\\/]+/u : /\/+/u;
  const trimmed = cwd.replace(new RegExp(`(?:${separator.source})$`, "u"), "");
  if (trimmed === "") return cwd.charAt(0);
  const parts = trimmed.split(separator);
  return parts[parts.length - 1] ?? "";
}

export function composerLift(stackHeight: number, composerHeight: number, greetingHeight: number): number {
  const spare = stackHeight - composerHeight - greetingHeight;
  if (!(spare > 0)) return 0;
  return 0 - Math.round(spare / 2);
}

export function greetingFits(stackHeight: number, composerHeight: number, greetingHeight: number): boolean {
  return stackHeight - composerHeight - greetingHeight >= 0;
}

export function roomOverComposer(stackHeight: number, composerHeight: number, lift: number, cardOffset: number): number {
  const room = stackHeight - composerHeight + lift + cardOffset;
  return room > 0 ? Math.round(room) : 0;
}
