import type { SkillActivity } from "../../shared/protocol.ts";

// agy 1.2.16 and 1.4.12: each invoked skill is one mention, its line naming the same skill as its body.
const MENTION = /(?:^|\n)\/([^\s()<>]{1,200}) is a \[Slash Command\]:\n<SKILL>The user has explicitly invoked the \(([^()\r\n<>]{1,200})\) skill\./g;

/**
 * The skills a USER_INPUT step's metadata block says the user invoked. A skill's body sits in the
 * same block, so a mention counts only for a `/name` the request itself holds.
 */
export function agyInvokedSkills(request: string, metadata: string): SkillActivity[] {
  const typed = new Set([...request.matchAll(/(?:^|\s)\/([^\s()<>]{1,200})(?=\s|$)/g)].map((match) => match[1]!));
  const names = new Set<string>();
  for (const match of metadata.matchAll(MENTION)) if (match[1] === match[2] && typed.has(match[1]!)) names.add(match[1]!);
  return [...names].map((name) => ({ name, evidence: "instructions", status: "loaded" }));
}
