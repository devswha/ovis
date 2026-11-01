import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommandOutcome } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { toTranscriptMessages } from "../lib/transcript.ts";
import { ChatFallback } from "./ChatView.tsx";

const raw = "❯ Thought TPS Todo are my words\n\nThought: keep this\n\nTPS 2\n\nTodo\n[ ] task\nContext 10%\n──────\n  indented  \n";
const outcome: CommandOutcome = {
  id: "sent-1", pane_id: "w1:p1", text: "Thought TPS Todo are my words", state: "accepted", evidence: [],
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
};

function render(scrollback: string, outcomes: CommandOutcome[] = []) {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChatFallback, {
      paneId: "w1:p1", agent: null, visible: true, messages: toTranscriptMessages(scrollback), scrollback,
      outcomes, restored: null, actions: null, skills: null,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("terminal scrollback snapshot", () => {
  it("shows every raw line once, with one copy control and no inferred assistant turns", () => {
    const html = render(raw);
    expect(html).toContain(raw);
    expect(html.match(/class="chat-terminal-snapshot"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Copy as plain text"/g)).toHaveLength(1);
    expect(html).not.toContain("chat-turn-agent");
    expect(html).not.toContain("Copy as markdown");
  });

  it("retains a matched command's outcome without duplicating its text", () => {
    const html = render(raw, [outcome]);
    expect(html).toContain('data-outcome-state="accepted"');
    expect(html.match(/Thought TPS Todo are my words/g)).toHaveLength(1);
  });

  it("keeps an unmatched send's status without adding a provisional bubble", () => {
    const html = render(raw, [{ ...outcome, text: "an unmatched command", state: "unknown" }]);
    expect(html).toContain('data-outcome-state="unknown"');
    expect(html).not.toContain("chat-turn-sent");
    expect(html).not.toContain("an unmatched command");
  });

  it("keeps outcome states without repeating preview or result text", () => {
    const html = render("preview in screen\nresult in screen", [
      { ...outcome, id: "preview", preview: "preview in screen" },
      { ...outcome, id: "result", state: "result-observed", evidence: [{ kind: "recognized-result", at: outcome.created_at }], result_text: "result in screen" },
    ]);
    expect(html.match(/preview in screen/g)).toHaveLength(1);
    expect(html.match(/result in screen/g)).toHaveLength(1);
    expect(html).toContain('data-outcome-state="accepted"');
    expect(html).toContain('data-outcome-state="result-observed"');
  });

  it("does not draw an empty snapshot", () => {
    expect(render("")).not.toContain("chat-terminal-snapshot");
  });
});
