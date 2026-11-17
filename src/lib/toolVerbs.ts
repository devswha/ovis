import { patchFiles, patchText } from "../../shared/patch.ts";

export type ToolVerbKind = "read" | "edit" | "write" | "run";

const VERB_LABEL: Record<ToolVerbKind, string> = {
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  run: "Ran",
};

const VERB_OF: Record<string, ToolVerbKind> = {
  read: "read",
  edit: "edit", multiedit: "edit", notebookedit: "edit", apply_patch: "edit", patch: "edit",
  write: "write",
  bash: "run", exec: "run", exec_command: "run", shell: "run", shell_command: "run", local_shell: "run",
};

const OBJECT_KEYS: Record<ToolVerbKind, readonly string[]> = {
  read: ["file_path", "path"],
  edit: ["file_path", "notebook_path", "path"],
  write: ["file_path", "path"],
  run: ["cmd", "command"],
};

const SUMMARY_LENGTH = 120;

export function toolVerbKind(name: string, input = ""): ToolVerbKind | null {
  const key = name.toLowerCase();
  if (!Object.hasOwn(VERB_OF, key)) return null;
  const kind = VERB_OF[key]!;
  return kind === "run" && patchText(input) !== null ? "edit" : kind;
}

function isObjectOf(kind: ToolVerbKind, input: string, object: string): boolean {
  const patch = patchText(input);
  if (patch !== null && patchFiles(patch).join(", ").slice(0, SUMMARY_LENGTH) === object) return true;
  let args: unknown;
  try { args = JSON.parse(input); } catch { return false; }
  if (typeof args !== "object" || args === null) return false;
  return OBJECT_KEYS[kind].some((key) => {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" && value.slice(0, SUMMARY_LENGTH) === object;
  });
}

const NARRATION_KEYS = ["summary", "description", "intent"] as const;

export function isToolNarration(part: { name: string; input: string }, summary: string): boolean {
  if (summary.trim().length === 0 || summary === part.name) return false;
  let args: unknown;
  try { args = JSON.parse(part.input); } catch { return false; }
  if (typeof args !== "object" || args === null) return false;
  return NARRATION_KEYS.some((key) => {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim().slice(0, SUMMARY_LENGTH) === summary;
  });
}

/**
 * A tool id as a row names it. Claude Code ids an MCP tool `mcp__<server>__<tool>`, its server
 * a claude.ai connector (`claude_ai_HomeAssistant`) or a plugin's (`plugin_playwright_playwright`,
 * from `plugin:playwright:playwright`): the row says the server and the tool, as Claude Code splits
 * them, without the connector's or the plugin's prefix (`HomeAssistant get_entity_state`). Any
 * other id is shown as the agent names it.
 */
export function toolDisplayName(name: string): string {
  const [prefix, server, ...rest] = name.split("__");
  const tool = rest.join("__");
  if (prefix !== "mcp" || !server || !tool) return name;
  const connector = /^claude_ai_(.+)$/.exec(server)?.[1];
  const plugin = /^plugin_(.+)$/.exec(server)?.[1];
  const shown = connector ?? (plugin !== undefined ? /^(.+)_\1$/.exec(plugin)?.[1] ?? plugin : server);
  return `${shown} ${tool}`;
}

export function toolVerb(part: { name: string; input: string }, object: string): string | null {
  if (object.trim().length === 0 || object === part.name) return null;
  const kind = toolVerbKind(part.name, part.input);
  return kind !== null && isObjectOf(kind, part.input, object) ? VERB_LABEL[kind] : null;
}
