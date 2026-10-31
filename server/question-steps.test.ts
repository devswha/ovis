import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { handlePromptRequest, parseInteractivePrompt } from "./prompt.ts";

// The card moves between a form's questions without answering, as the agent's own keys do: OmO's
// Tab and Shift+Tab, Codex's ←/→, Hermes's Tab and Shift+Tab. Each key is sent alone and the
// screen must show the question it moves to before the next one.

const rule = "─".repeat(119);
const omoFooter = `${rule}\n~/omo-proj • main • 25K/200K (12.7%) (auto)      (anthropic) claude-haiku-4-5-20251001:off\n(😺 OmO Native by Q Kim)\n`;
const QUESTIONS = [["Color", "Which color do you prefer?", ["Red", "Blue"]], ["Size", "Which size?", ["Small", "Large"]], ["Shape", "Which shape?", ["Circle", "Square"]]] as const;

/** omo 5.1.51's form of three questions, as captured in a 120-column herdr pane: `at` 3 is its Submit tab. */
function omo(at: number, answered: number[] = []): string {
  const tabs = [...QUESTIONS.map(([header], index) => `${index === at ? "→ " : "  "}${header}${answered.includes(index) ? " ✓" : ""}`), `${at === 3 ? "→ " : "  "}Submit`];
  const count = `${answered.length}/3 answered`;
  const body = at === 3
    ? [" Review your answers", ...QUESTIONS.map(([header]) => `   ${header}: unanswered`), "", " Comment (optional; unanswered questions are reported)", ">",
      ` Submit (${count})`, " enter submit  ↑ review answers  shift+tab back  tab next question  esc back"]
    : [` ${QUESTIONS[at]![1]}`, ...QUESTIONS[at]![2].map((option, row) => `${row === 0 ? " → " : "   "}${row + 1}. ${option}`), "   Type your own answer...",
      ` Submit (${count}) - Enter advances`, " ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel"];
  return `\n [Color] [Size] [Shape] wait for answer\n\n${rule}\n\n Ask user · 30m\n ${tabs.join("  ")}\n${body.join("\n")}\n\n${omoFooter}`;
}

/** Codex 0.166's request_user_input with two questions. */
function codex(at: number): string {
  const [question, options] = at === 0 ? ["Which model?", ["small (Recommended)  The fast one.", "large                The careful one."]] : ["Which split?", ["train (Recommended)  Use the training split.", "test                 Use the test split."]];
  return `
  Question ${at + 1}/2 (2 unanswered)
  ${question}
  › 1. ${options[0]}
    2. ${options[1]}
    3. None of the above    Optionally, add details in notes (tab).
  tab to add notes | enter to ${at === 1 ? "submit all" : "submit answer"} | ←/→ to navigate questions | esc to interrupt
`;
}

const HERMES_HINT = "answered · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel";
const HERMES = [["Pick a colour", ["Red", "Blue"]], ["Pick a size", ["Small", "Large"]], ["Pick a shape", ["Circle", "Square"]]] as const;

/** Hermes's clarify batch (ui-tui prompts.tsx): `✓` answered, `▸` the open one expanded, `·` waiting. */
function hermes(at: number, answered: number[] = []): string {
  const lines = HERMES.flatMap(([question, choices], index) => [
    ` ${answered.includes(index) ? "✓" : index === at ? "▸" : "·"} ${question}`,
    ...(answered.includes(index) ? [`   ${choices[0]}`] : []),
    ...(index === at ? [...choices, "Other (type your answer)"].map((choice, row) => `   ${row === 0 ? "▸" : " "} ${row + 1}. ${choice}`) : []),
  ]);
  return `\n ask 3 questions\n${lines.join("\n")}\n ${answered.length}/3 ${HERMES_HINT}\n ─ (⌐■_■) deliberating…  · 10s │ opus 5.5\n`;
}

const navigable = (prompt: InteractivePrompt | null) => prompt?.steps?.map((step) => step.can_navigate === true);

describe("OmO's form: the card goes to another question as Tab and Shift+Tab do", () => {
  test("every other question is a step to tap, with Back and Next", () => {
    const first = parseInteractivePrompt("pi", omo(0));
    expect(first).toMatchObject({ agent: "omo", title: "Question 1 of 3", can_step_next: true });
    expect(first?.can_step_back ?? false).toBe(false);
    expect(navigable(first)).toEqual([false, true, true]);
    const second = parseInteractivePrompt("pi", omo(1));
    expect(second).toMatchObject({ title: "Question 2 of 3", can_step_back: true, can_step_next: true });
    expect(navigable(second)).toEqual([true, false, true]);
    // Next on the last question goes on to the review, as Tab does
    expect(parseInteractivePrompt("pi", omo(2))).toMatchObject({ can_step_back: true, can_step_next: true });
  });

  test("the review goes back to any question, and has no Next", () => {
    const review = parseInteractivePrompt("pi", omo(3));
    expect(review).toMatchObject({ title: "Review your answers", can_step_back: true });
    expect(review?.can_step_next ?? false).toBe(false);
    expect(navigable(review)).toEqual([true, true, true]);
  });

  test("an answer typed in the terminal holds the form: Tab would save it, so no step is offered", () => {
    const typing = omo(0).replace("   Type your own answer...\n Submit (0/3 answered) - Enter advances\n ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel",
      " Your answer (enter to save, ↑↓ back to options, esc to discard)\n> blu\n Submit (0/3 answered) - Enter advances\n enter save and next  ↑↓ back to options  tab next question  esc discard");
    const prompt = parseInteractivePrompt("pi", typing);
    expect(prompt?.kind).toBe("menu");
    expect(navigable(prompt)).toEqual([false, false, false]);
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("Codex's questions: the card goes back and on as ←/→ do", () => {
  test("Back after the first question, Next before the last", () => {
    const first = parseInteractivePrompt("codex", codex(0));
    expect(first).toMatchObject({ title: "Question 1 of 2", can_step_next: true });
    expect(first?.can_step_back ?? false).toBe(false);
    const last = parseInteractivePrompt("codex", codex(1));
    expect(last).toMatchObject({ title: "Question 2 of 2", can_step_back: true });
    expect(last?.can_step_next ?? false).toBe(false);
  });

  test("a hint without ←/→ offers neither", () => {
    const prompt = parseInteractivePrompt("codex", codex(0).replace(" | ←/→ to navigate questions", ""));
    expect(prompt?.title).toBe("Question 1 of 2");
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("Hermes's clarify batch: the card goes to another open question as Tab and Shift+Tab do", () => {
  test("each question is a step; the open ones can be gone to", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(0));
    expect(prompt?.question).toBe("Pick a colour");
    expect(prompt?.steps?.map((step) => [step.label, step.answered, step.current])).toEqual([["Pick a colour", false, true], ["Pick a size", false, false], ["Pick a shape", false, false]]);
    expect(navigable(prompt)).toEqual([false, true, true]);
    expect(prompt).toMatchObject({ can_step_next: true });
    expect(prompt?.can_step_back ?? false).toBe(false);
  });

  test("an answered question shows no open marker once Tab is on it: nothing past it is offered", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(0, [1]));
    expect(prompt?.steps?.map((step) => step.answered)).toEqual([false, true, false]);
    expect(navigable(prompt)).toEqual([false, false, false]);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

interface Pane { agent: string; screen: string; sent: string[]; onSent?: (key: string) => void }

async function withPane(agent: string, screen: string, run: (pane: Pane) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "question-steps-"));
  const path = join(root, "herdr.sock");
  const pane: Pane = { agent, screen, sent: [] };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string } };
      const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "session.snapshot") return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: pane.agent, agent_status: "blocked" }], layouts: [] } });
      if (request.method === "pane.read") return answer({ read: { text: pane.screen } });
      if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: pane.agent === "codex" ? [{ pid: 2147483647, argv: ["/usr/bin/codex"] }] : [] } });
      if (request.method === "agent.get") return answer({ agent: {} });
      if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
      for (const sent of request.params.keys ?? [`text:${request.params.text}`]) {
        pane.sent.push(sent);
        pane.onSent?.(sent);
      }
      answer({});
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try { await run(pane); } finally {
    if (previous === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function card(): Promise<InteractivePrompt> {
  const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
  const prompt = ((await (await handlePromptRequest(new Request(url), url, {}))!.json()) as { prompt: InteractivePrompt | null }).prompt;
  expect(prompt).not.toBeNull();
  return prompt!;
}

async function move(promptId: string, action: Omit<PromptAnswer, "pane_id" | "prompt_id">): Promise<{ status: number; code?: string }> {
  const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
  const response = (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...action }) }), url, {}))!;
  const body = await response.json() as { error?: { code: string } };
  return { status: response.status, code: body.error?.code };
}

/** A pane whose form moves as the agent's keys move it, wrapping as they do. */
function follows(pane: Pane, draw: (at: number) => string, count: number, next: string, previous: string, start = 0): void {
  let at = start;
  pane.onSent = (key) => {
    if (key === next) at = (at + 1) % count;
    if (key === previous) at = (at + count - 1) % count;
    pane.screen = draw(at);
  };
}

describe("the answer route moves between questions, one key at a time, each seen", () => {
  test("OmO: Next sends Tab, and the card that comes back is the next question, not answered", async () => {
    await withPane("pi", omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      const first = await card();
      expect(await move(first.id, { step_next: true, draft: { option_indices: [], custom_text: "" } })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
      const second = await card();
      expect(second).toMatchObject({ title: "Question 2 of 3", question: "Which size?" });
      expect(second.steps?.map((step) => step.answered)).toEqual([false, false, false]);
    });
  });

  test("OmO: a tapped step two questions on sends Tab twice; Back on the review sends Shift+Tab", async () => {
    await withPane("pi", omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      expect(await move((await card()).id, { step_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab", "tab"]);
      expect((await card()).question).toBe("Which shape?");
    });
    await withPane("pi", omo(3), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab", 3);
      expect(await move((await card()).id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["shift+tab"]);
      expect((await card()).question).toBe("Which shape?");
    });
  });

  test("OmO: a form that does not move stops after its first key", async () => {
    await withPane("pi", omo(0), async (pane) => {
      expect(await move((await card()).id, { step_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test("OmO: another form drawn after the first Tab gets no second one", async () => {
    // the same labels, another call: omo asked again with other questions
    const other = (at: number) => omo(at).replaceAll("Which shape?", "Which shape, again?").replace(" Ask user · 30m", " Ask user · 29m").replace("[Color] [Size] [Shape]", "[Colour] [Size] [Shape]").replace("→ Color", "→ Colour").replace("  Color", "  Colour");
    await withPane("pi", omo(0), async (pane) => {
      pane.onSent = () => { pane.screen = other(1); };
      expect(await move((await card()).id, { step_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
    // and a screen that changed between the card and the move: no key at all
    await withPane("pi", omo(0), async (pane) => {
      const first = await card();
      pane.screen = other(0);
      expect((await move(first.id, { step_index: 2 })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
  });

  test("OmO: an answer with the move, a step out of reach or the card's unsent edits send nothing", async () => {
    await withPane("pi", omo(0), async (pane) => {
      const first = await card();
      const refused = { status: 400, code: "invalid_answer" };
      expect(await move(first.id, { step_next: true, option_index: 0 })).toEqual(refused);
      expect(await move(first.id, { step_back: true })).toEqual(refused);
      expect(await move(first.id, { step_next: true, step_back: true })).toEqual(refused);
      expect(await move(first.id, { step_index: 0 })).toEqual(refused);
      expect(await move(first.id, { step_next: true, draft: { option_indices: [], custom_text: "green" } })).toEqual(refused);
      expect(pane.sent).toEqual([]);
    });
  });

  test("Codex: Next sends → and Back sends ←, each seen on screen", async () => {
    await withPane("codex", codex(0), async (pane) => {
      let at = 0;
      pane.onSent = (key) => { at = key === "right" ? Math.min(1, at + 1) : key === "left" ? Math.max(0, at - 1) : at; pane.screen = codex(at); };
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect((await card()).question).toBe("Which split?");
      expect(await move((await card()).id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["right", "left"]);
      expect((await card()).question).toBe("Which model?");
    });
  });

  test("Hermes: Next sends Tab, and the card comes back on the next open question", async () => {
    await withPane("hermes", hermes(0), async (pane) => {
      follows(pane, (at) => hermes(at), 3, "tab", "shift+tab");
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
      expect((await card()).question).toBe("Pick a size");
    });
  });

  test("a card with no keys of its own to move by refuses Next", async () => {
    const one = `\n ask 1 question\n ▸ Pick a colour\n   ▸ 1. Red\n     2. Blue\n     3. Other (type your answer)\n 0/1 ${HERMES_HINT}\n`;
    await withPane("hermes", one, async (pane) => {
      // with an answer in the same body, too: Next is never read as that answer
      expect(await move((await card()).id, { step_next: true, option_index: 0 })).toEqual({ status: 400, code: "invalid_answer" });
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 400, code: "invalid_answer" });
      expect(pane.sent).toEqual([]);
    });
  });
});
