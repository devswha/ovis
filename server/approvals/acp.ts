/**
 * The cards of an ACP child (server/acp/children.ts): each `session/request_permission` its agent asks becomes a card
 * with the agent's own options, unchanged and in order, and the card's answer is the option the agent gets. Ovis asks
 * nothing of its own, so a child that requests nothing has no card. The card shows the oldest request nobody answered
 * yet; its id names that request (the keeper's id and a digest of the request as archived), so an answer settles that
 * request and no other.
 */
import { createHash } from "node:crypto";
import type { CardText, InteractivePrompt } from "../../shared/protocol.ts";
import type { AcpApproval, KeeperClient } from "../acp/client.ts";
import { englishOf, own } from "../dialogs/shared.ts";
import { showable } from "./hub.ts";

/** The ACP child running in a pane, as the prompt routes look it up. */
export interface AcpCards {
  forPane(paneId: string): { harness: string; client: KeeperClient } | undefined;
}

/** The most of a card's body the bridge and the card show (finishPrompt, promptWords). */
const CARD_BODY_MAX = 12_000;
const TITLE: CardText = own("Permission request");
const QUESTION: CardText = own("Choose an option");

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

/** The agent's command, its other input, and the content it sent with the request, in that order. */
function words({ rawInput, content }: AcpApproval["toolCall"]): string[] {
  const input = record(rawInput);
  const command = input?.["command"];
  const shown = typeof command === "string" ? [command]
    : Array.isArray(command) && command.every((word) => typeof word === "string") ? [command.join(" ")]
    : rawInput === null || (input !== null && Object.keys(input).length === 0) ? []
    : [JSON.stringify(rawInput, null, 2)];
  for (const item of Array.isArray(content) ? content : []) {
    const entry = record(item);
    const said = entry?.["type"] === "content" ? text(record(entry["content"])?.["text"])
      : entry?.["type"] === "diff" ? [text(entry["path"]), text(entry["newText"])].filter((part) => part !== null).join("\n") || null
      : null;
    if (said !== null) shown.push(said);
  }
  return shown;
}

/**
 * The card for one request. Its body is the request's words only where the card can show them whole and as they are;
 * otherwise none, and the card still offers the options (no terminal holds this request to answer it instead).
 */
export function acpCard(harness: string, approval: AcpApproval): InteractivePrompt {
  const title = text(approval.toolCall.title);
  const ownTitle = title === null || !showable(title);
  const body = words(approval.toolCall).join("\n\n");
  return {
    id: `acp.${approval.keeperId}.${createHash("sha256").update(approval.raw).digest("hex").slice(0, 16)}`,
    agent: harness,
    kind: "approval",
    title: ownTitle ? englishOf(TITLE) : title,
    question: englishOf(QUESTION),
    body: body === "" || body.length > CARD_BODY_MAX || !showable(body) ? null : body,
    options: approval.options.map((option) => ({ label: option.name, description: null })),
    multi_select: false,
    custom_option_index: null,
    own_text: { ...(ownTitle ? { title: TITLE } : {}), question: QUESTION },
  };
}

/** The card a pane's ACP child shows now: its oldest open request, or none. */
export function acpPrompt(child: { harness: string; client: KeeperClient }): InteractivePrompt | null {
  const oldest = child.client.pending()[0];
  return oldest === undefined ? null : acpCard(child.harness, oldest);
}

/**
 * Answers the card `promptId` with its option `optionIndex`: answered once the keeper sent this answer to the agent;
 * changed when the request is no longer open or another answer went first; invalid for an option the card has not.
 */
export async function answerAcpPrompt(child: { harness: string; client: KeeperClient }, promptId: string, optionIndex: unknown): Promise<"answered" | "changed" | "invalid"> {
  const asked = child.client.pending().find((request) => acpCard(child.harness, request).id === promptId);
  if (asked === undefined) return "changed";
  const option = typeof optionIndex === "number" && Number.isInteger(optionIndex) ? asked.options[optionIndex] : undefined;
  if (option === undefined) return "invalid";
  return await child.client.answer(asked.keeperId, option.optionId) === "won" ? "answered" : "changed";
}
