import type { CardText, InteractivePrompt, InteractivePromptOption, PromptAnswer } from "../../shared/protocol.ts";
import { englishOf, own } from "../dialogs/shared.ts";
import { heldBody, type ApprovalHub, type HeldApproval } from "./hub.ts";

const terminal = own("Answer in terminal");
const custom = own("Type your answer");
const permission = own("Permission request");
const choice = own("Choose an option");
const idOf = (entry: HeldApproval) => `cmd.${entry.id}`;

/** Only the relay can open these cards; a terminal screen can neither open nor answer one. */
export function cmdCard(entry: HeldApproval): InteractivePrompt {
  const q = entry.question;
  const options: InteractivePromptOption[] = q?.options.map((label, i) => ({ label, description: q.descriptions?.[i] || null })) ?? [];
  const labels: Record<number, CardText> = {};
  const append = (text: CardText) => {
    labels[options.length] = text;
    options.push({ label: englishOf(text), description: null });
  };
  if (!q) { append(own("Allow once")); append(own("Deny")); }
  labels[options.length] = terminal;
  options.push({ label: englishOf(terminal), description: null, action: "terminal" });
  const customIndex = q ? options.length : null;
  if (q) append(custom);
  return {
    id: idOf(entry), agent: "cmd", kind: q ? "question" : "approval",
    title: q ? entry.description ?? q.text : englishOf(permission), question: q?.text ?? englishOf(choice),
    body: q ? null : heldBody(entry), options, multi_select: q?.multiple === true,
    ...(q?.multiple ? { checks_with_text: true } : {}), custom_option_index: customIndex,
    own_text: { labels, ...q ? {} : { title: permission, question: choice } },
  };
}

export function cmdPending(hub: ApprovalHub | null | undefined, paneId: string): HeldApproval | undefined {
  return hub?.held(paneId).find(entry => entry.kind === "cmd");
}

export function answerCmdCard(hub: ApprovalHub | undefined, body: PromptAnswer): "answered" | "changed" | "invalid" {
  const entry = cmdPending(hub, body.pane_id);
  if (!hub || !entry || body.prompt_id !== idOf(entry)) return "changed";
  if (body.step_back !== undefined || body.step_next !== undefined || body.step_index !== undefined || body.draft !== undefined) return "invalid";
  const { option_index: index, option_indices: indices, custom_text: text } = body;
  const q = entry.question;
  const handoff = q?.options.length ?? 2;
  const picks = indices ?? (index === undefined ? [] : [index]);
  if (indices !== undefined && (!q?.multiple || index !== undefined || !Array.isArray(indices))) return "invalid";
  if (picks.length === 1 && picks[0] === handoff && text === undefined) {
    hub.settle(body.pane_id, entry.id, null);
  } else if (!q) {
    if ((index !== 0 && index !== 1) || text !== undefined) return "invalid";
    hub.settle(body.pane_id, entry.id, index === 0 ? "allow" : "deny");
  } else {
    if (picks.some(i => !Number.isInteger(i) || i < 0 || i >= q.options.length) || new Set(picks).size !== picks.length
      || (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > 12_000 || (!q.multiple && picks.length > 0)))) return "invalid";
    const values = picks.map(i => q.options[i]);
    if (text !== undefined) values.push(text.trim());
    if (!values.length) return "invalid";
    hub.settle(body.pane_id, entry.id, "allow", { input: {}, answers: { [q.text]: q.multiple ? JSON.stringify(values) : values.join("") } });
  }
  return "answered";
}
