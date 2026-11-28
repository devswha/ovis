import { ANSI_RE, SOLID_RULE_RE, finishPrompt, type DialogReader, type ParsedPrompt } from "./shared.ts";

const hint = "↑/↓ select · enter accept · ctrl+d decline · esc cancel";
const other = "Other (type your answer)";
const editing = "Other (type your answer below)";
export const copilotPlaceholder = "Type your answer...";

export const readers: readonly DialogReader[] = [{
  id: "copilot-question", agents: ["copilot"], priority: 20, reread: "each-move", list: "none",
  // Like Pi's questionnaire, only readKnownPrompt can supply a verified pending call.
  parse: () => null,
}];

/** Match the whole live single-choice panel, not the same question quoted in a turn above the composer. */
export function copilotQuestion(screen: string, call: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").trimEnd().split(/\r?\n/).map(line => line.trimEnd());
  let draft: string | undefined;
  if (SOLID_RULE_RE.test(lines.at(-1)?.trim() ?? "") && lines.at(-2)?.startsWith("❯ ") && SOLID_RULE_RE.test(lines.at(-3)?.trim() ?? "")) {
    const value = lines.at(-2)!.slice(2);
    draft = value === copilotPlaceholder ? "" : value;
    lines.splice(-3);
  }
  if (!SOLID_RULE_RE.test(lines.pop()?.trim() ?? "") || lines.pop()?.trim() !== hint || lines.pop() !== "") return null;
  const header = lines.lastIndexOf(" Copilot needs information.");
  if (header < 1 || !SOLID_RULE_RE.test(lines[header - 1]!.trim())) return null;
  const panel = lines.slice(header + 1);
  const split = panel.indexOf("");
  if (split !== 1 || !panel[0]!.trim() || !/^ [^ ].*:$/.test(panel[2] ?? "")) return null;
  const rows = panel.slice(3).map(line => /^ (❯ |  )(\S.*)$/u.exec(line));
  if (rows.length === 0 || rows.some(row => !row) || rows.filter(row => row?.[1] === "❯ ").length !== 1) return null;
  const labels = rows.map(row => row![2]!);
  if (new Set(labels).size !== labels.length) return null;
  if ((labels.at(-1) === editing && rows.at(-1)?.[1] === "❯ ") !== (draft !== undefined)) return null;
  const custom = labels.at(-1) === other || draft !== undefined;
  const choices = custom ? labels.slice(0, -1) : labels;
  if (!choices.length) return null;
  return finishPrompt("copilot", {
    kind: "question", title: panel[2]!.trim().slice(0, -1), question: panel[0]!.trim(), body: null,
    options: choices.map(label => ({ label, description: null })), multi_select: false, custom_option_index: custom ? choices.length : null,
  }, {
    responder: "copilot-question", menuLabels: labels, selectedIndex: rows.findIndex(row => row?.[1] === "❯ "),
    checkedOptionIndices: [], customMenuIndex: custom ? choices.length : null, rejectWithEscapeIndex: null, copilotDraft: draft,
  }, { call });
}
