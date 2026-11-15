/** A model's maker, by the start of its name, as the agent whose mark stands for it. */
const MODEL_MARKS: [RegExp, string][] = [
  [/^claude/, "claude"],
  [/^(gpt|o\d|codex)/, "codex"],
  [/^gemini/, "gemini"],
  [/^grok/, "grok"],
  [/^kimi/, "kimi"],
  [/^qwen/, "qwen"],
];

/** A routed model keeps its maker's mark. Null for a maker without one. */
export function modelMark(model: string): string | null {
  const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  return MODEL_MARKS.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}
