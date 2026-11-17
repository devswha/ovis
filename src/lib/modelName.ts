export interface ModelLabel {
  text: string;
  named: boolean;
}

const NUMBER = "[1-9]\\d?";
const CLAUDE = new RegExp(`^(?:anthropic/)?claude-(opus|sonnet|haiku|fable|mythos)-(${NUMBER})(?:-(0|${NUMBER}))?$`, "u");
const GPT = new RegExp(`^gpt-(${NUMBER}(?:\\.${NUMBER})?)(-sol)?$`, "u");
const GLM = new RegExp(`^glm-(${NUMBER}(?:\\.${NUMBER})?)$`, "u");

export function modelLabel(id: string): ModelLabel {
  const claude = CLAUDE.exec(id);
  if (claude) {
    const family = claude[1]!;
    return { text: `${family.charAt(0).toUpperCase()}${family.slice(1)} ${claude[2]}${claude[3] === undefined ? "" : `.${claude[3]}`}`, named: true };
  }
  const gpt = GPT.exec(id);
  if (gpt) return { text: `GPT-${gpt[1]}${gpt[2] === undefined ? "" : "-Sol"}`, named: true };
  const glm = GLM.exec(id);
  if (glm) return { text: `GLM-${glm[1]}`, named: true };
  return { text: id, named: false };
}
