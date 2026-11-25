import { isRecord } from "../../shared/harness-tool.ts";
import { showable } from "../approvals/hub.ts";

type Choice = { readonly label: string; readonly value: string; readonly description: string | null };
export interface QuestionField {
  readonly key: string;
  readonly prompt: string;
  readonly choices: readonly Choice[];
  readonly multiple: boolean;
  readonly custom: string | null;
}

export const hasQuestionForms = (harness: string) => ["claude", "codex", "opencode", "agy", "gjc"].includes(harness);
const words = (s: unknown): s is string => typeof s === "string" && s.trim() !== "" && s.length <= 4096 && showable(s);

/** Parse only native clarification forms. MCP elicitation, OAuth, Claude confirm_* and
 * fallback-model consent are NOT clarification, even when they offer a select field. */
export function questionFields(harness: string, p: Record<string, unknown>): QuestionField[] | null {
  if (p.mode !== "form" || !words(p.message) || (harness !== "gjc" && !words(p.toolCallId)) || !isRecord(p.requestedSchema)
    || p.requestedSchema.type !== "object" || !isRecord(p.requestedSchema.properties)) return null;
  const properties = p.requestedSchema.properties;
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > 32) return null;
  if (harness === "claude" && typeof p.toolCallId === "string" && p.toolCallId.startsWith("confirm_")) return null;
  const fields: QuestionField[] = [];
  const consumed = new Set<string>();
  for (const [key, field] of entries) {
    if (!isRecord(field) || !/^[\w.-]{1,128}$/.test(key)) return null;
    const codex = isRecord(field._meta) && isRecord(field._meta.codex) ? field._meta.codex : null;
    if (harness === "codex" ? codex?.role === "user_note" : key.endsWith(harness === "agy" ? "_other" : "_custom")) continue;
    let customKey: string | undefined;
    let prompt: unknown;
    switch (harness) {
      case "claude":
        if (key !== `question_${fields.length}`) return null;
        prompt = field.description ?? p.message;
        customKey = `${key}_custom`;
        break;
      case "opencode":
        if (key !== `q${fields.length}`) return null;
        prompt = field.description;
        customKey = `${key}_custom`;
        break;
      case "agy":
        if (key !== `q${fields.length + 1}`) return null;
        prompt = field.title;
        customKey = `${key}_other`;
        break;
      case "gjc":
        if (key !== "value" || entries.length !== 1 || p.toolCallId != null) return null;
        prompt = p.message;
        break;
      case "codex":
        if (codex?.isSecret !== false || typeof codex.isOther !== "boolean" || !isRecord(p._meta) || !isRecord(p._meta.codex)
          || !Object.hasOwn(p._meta.codex, "autoResolutionMs")) return null;
        prompt = field.title;
        customKey = entries.find(([, f]) => isRecord(f) && isRecord(f._meta) && isRecord(f._meta.codex)
          && f._meta.codex.role === "user_note" && f._meta.codex.isSecret === false && f._meta.codex.questionId === key)?.[0];
        break;
      default: return null;
    }
    if (!words(prompt)) return null;
    const multiple = field.type === "array";
    const options = multiple && isRecord(field.items) ? field.items.anyOf : field.oneOf;
    const freeText = harness === "codex" || harness === "gjc" && Object.keys(field).every(k => k === "type")
      && Array.isArray(p.requestedSchema.required) && p.requestedSchema.required.length === 1 && p.requestedSchema.required[0] === "value";
    if ((!multiple && field.type !== "string") || (options === undefined && (multiple || !freeText))) return null;
    if (options !== undefined && (!Array.isArray(options) || !options.length || options.length > 32)) return null;
    const choices: Choice[] = [];
    for (const opt of options ?? []) {
      if (!isRecord(opt) || !words(opt.const) || !words(opt.title) || (opt.description != null && !words(opt.description))) return null;
      if (harness === "gjc" && opt.const !== `option:${choices.length}`) return null;
      choices.push({ value: opt.const, label: opt.title, description: opt.description ?? null });
    }
    consumed.add(key);
    let custom = choices.length === 0 ? key : null;
    if (customKey && Object.hasOwn(properties, customKey)) {
      const other = properties[customKey];
      if (!isRecord(other) || other.type !== "string") return null;
      consumed.add(customKey);
      custom = customKey;
    }
    fields.push({ key, prompt, choices, multiple, custom });
  }
  return fields.length && consumed.size === entries.length ? fields : null;
}
