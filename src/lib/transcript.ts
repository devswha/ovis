
export type TranscriptRole = "user" | "agent" | "status";

export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
}

const RULE_LINE = /^[─━═]{6,}$/;
const USER_LINE = /^❯\s?/;
const STATUS_LINE =
  /^(?:\[[^\]]*\]\s*│|⏵|⣾|█|Context\s|Usage\s|[·•]\s*\d+\s*shell|✳|※)/;

export function toTranscriptMessages(text: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let pending: { role: TranscriptRole; lines: string[] } | null = null;

  const flush = (): void => {
    if (pending === null) return;
    if (pending.role === "agent") {
      let chunk: string[] = [];
      const emit = (): void => {
        const body = chunk.join("\n").replace(/^\n+|\n+$/g, "");
        if (body.length > 0) messages.push({ role: "agent", text: body });
        chunk = [];
      };
      for (const line of pending.lines) {
        if (line.trim().length === 0) emit();
        else chunk.push(line);
      }
      emit();
    } else {
      const body = pending.lines.join("\n").replace(/^\n+|\n+$/g, "");
      if (body.length > 0) messages.push({ role: pending.role, text: body });
    }
    pending = null;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trimEnd();
    if (RULE_LINE.test(line.trim())) {
      flush();
      continue;
    }
    if (USER_LINE.test(line.trim())) {
      flush();
      const prompt = line.trim().replace(USER_LINE, "").trim();
      if (prompt.length > 0) messages.push({ role: "user", text: prompt });
      continue;
    }
    const role: TranscriptRole = STATUS_LINE.test(line.trim()) ? "status" : "agent";
    if (pending !== null && pending.role === role) {
      pending.lines.push(line);
      continue;
    }
    flush();
    pending = { role, lines: [line] };
  }
  flush();
  return messages;
}
