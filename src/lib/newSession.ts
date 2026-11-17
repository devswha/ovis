import type { CreateTabRequest, CreateWorkspaceRequest, WorkspaceCreated } from "../../shared/protocol.ts";
import type { ClaudeLaunchMode, CodexLaunchMode } from "./agentLaunchMode.ts";
import { firstPromptDelivery, launchAgent, launchCapabilities, launchChoiceFault } from "./agentLaunchMode.ts";

export interface NewSessionFields {
  agent: string;
  model: string;
  effort: string;
  ultracode?: boolean;
  prompt: string;
}

export type FirstPrompt = { text: string; via: "positional" | "pending" };

export type NewSessionLaunch =
  | { agent: { kind: string; args?: string[] } | null; prompt: FirstPrompt | null }
  | { fault: "model" | "effort" | "ultracode" | "prompt" };

export function newSessionLaunch(fields: NewSessionFields, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }): NewSessionLaunch {
  const fault = launchChoiceFault(fields.agent, fields);
  if (fault !== null) return { fault };
  const via = firstPromptDelivery(fields.agent, fields.prompt);
  const text = fields.prompt.trim();
  return {
    agent: launchAgent(fields.agent, modes, { model: fields.model, effort: fields.effort, ultracode: fields.ultracode, prompt: via === "positional" ? text : "" }),
    prompt: via === null ? null : { text, via },
  };
}

export function dialogLaunch(fields: NewSessionFields, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }): NewSessionLaunch {
  return newSessionLaunch({ ...fields, ultracode: fields.ultracode && launchCapabilities(fields.agent).ultracode }, modes);
}

export function firstMessageOf(launch: NewSessionLaunch): string | null {
  return "fault" in launch || launch.prompt?.via !== "pending" ? null : launch.prompt.text;
}

export interface NewSessionTarget {
  tab: { workspaceId: string; cwd: string | null } | null;
  directory: string;
  name: string;
}

export function createRequest(target: NewSessionTarget, launch: Exclude<NewSessionLaunch, { fault: unknown }>, connection: string | null): CreateWorkspaceRequest | CreateTabRequest {
  const text = firstMessageOf(launch);
  const message = text === null ? {} : { first_message: text, ...(connection === null ? {} : { first_message_connection: connection }) };
  const label = target.name.trim() || null;
  return target.tab
    ? { workspace_id: target.tab.workspaceId, cwd: target.tab.cwd, label, agent: launch.agent, ...message }
    : { cwd: target.directory.trim() || null, label, agent: launch.agent, ...message };
}

export function startNewSession<T>(guard: { run: <R>(task: () => Promise<R>) => Promise<R> | null }, request: CreateWorkspaceRequest | CreateTabRequest,
  create: (request: CreateWorkspaceRequest | CreateTabRequest) => Promise<T>): Promise<T> | null {
  return guard.run(() => create(request));
}

export type FirstMessageOutcome = { kind: "none" } | { kind: "queued" } | { kind: "not_queued"; error: { code: string; message: string } | null };

export function firstMessageOutcome(request: CreateWorkspaceRequest, result: WorkspaceCreated): FirstMessageOutcome {
  if (typeof request.first_message !== "string" || !result.agent_started) return { kind: "none" };
  const answer = result.first_message;
  if (answer && "id" in answer) return { kind: "queued" };
  return { kind: "not_queued", error: answer && "error" in answer ? answer.error : null };
}
