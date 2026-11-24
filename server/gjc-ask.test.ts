import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gjcAskPrompt } from "./gjc-ask.ts";
import { gjcCustomEditorMatches, parseFallbackPrompt } from "./dialogs/fallback.ts";
import { parsedByPublicPrompt } from "./dialogs/shared.ts";
import { OmoAskReader, ompAsksAfter, type OmoAsks } from "./omo-ask.ts";
import { answerKeys } from "./prompt.ts";

/**
 * gjc 0.22.0 in Ovis (200 columns): the screen recorded while its ask selector was open, and the session's call for
 * it, reduced from the recorded session file to the user message and the assistant message that holds the call
 * (server/fixtures/gjc-ask-0.22.0-*).
 */
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/gjc-ask-0.22.0-${name}`, import.meta.url));
const SCREEN = readFileSync(fixture("single.txt"), "utf8");
const open = (): OmoAsks => new OmoAskReader(ompAsksAfter).read(fixture("open.jsonl"));
const card = (screen = SCREEN) => parseFallbackPrompt("gjc", screen);

type Asked = { questions: { id?: string; question: string; options: { label: string }[]; recommended?: number; multi?: boolean }[] };
const withArgs = (asks: OmoAsks, change: (args: Asked) => void): OmoAsks => asks.map((call) => {
  const args = structuredClone(call.args) as Asked;
  change(args);
  return { ...call, args };
});
const QUESTION = (open()[0]!.args as Asked).questions[0]!.question;
const FIRST_ROW = "Fixture capture for the GJC ask card. This first paragraph mentions inline code and bold words.";
const LAST_ROW = "Which option looks right? (캡처용, 15초 두고 아무거나 골라줘)";

describe("gjc ask cards in the agent's own Markdown", () => {
  it("reads the recorded selector as the generic card does: the title's last row and a body", () => {
    const read = card();
    expect(read.question).toBe(LAST_ROW);
    expect(read.body).toBe(`${FIRST_ROW}\nA second line in the same paragraph.\nA second paragraph with a list:\n- first item\n- second item`);
    expect(read.text_format).toBeUndefined();
  });

  it("gives the open call's whole question and labels to the selector it draws, keeping its id and keys", () => {
    const read = card();
    const rich = gjcAskPrompt(read, open());
    expect(rich).toMatchObject({
      id: read.id, kind: "menu", question: QUESTION, body: null, text_format: "markdown", custom_option_index: 3, multi_select: false,
      options: [
        { label: "Keep `local` socket (Recommended)", description: null },
        { label: "Remote relay", description: null },
        { label: "Neither", description: null },
        { label: "Other (type your own)", description: null },
        { label: "Esc", description: null },
      ],
    });
    for (const option_index of [0, 1, 2, 4]) expect(answerKeys(rich, { option_index })).toEqual(answerKeys(read, { option_index }));
    expect(answerKeys(rich, { custom_text: "mine" })).toEqual(answerKeys(read, { custom_text: "mine" }));
  });

  it("keeps the selector's custom-editor identity, so a typed answer is still checked against its editor", () => {
    const read = card();
    const rich = gjcAskPrompt(read, open());
    const editor = SCREEN.replace(/│❯ Keep/u, "│  Keep").replace("│  Other (type your own)", "│❯ Other (type your own)")
      .replace(/ ↑\/↓ select .*\n/u, " > mine\n\n enter submit  esc back to options  ctrl+g external editor  PgUp/PgDn: question · Wheel: transcript\n");
    expect(gjcCustomEditorMatches(editor, parsedByPublicPrompt.get(read)!, "mine")).toBe(true);
    expect(gjcCustomEditorMatches(editor, parsedByPublicPrompt.get(rich)!, "mine")).toBe(true);
  });

  it("reads a question gjc wrapped at a narrow pane", () => {
    const narrow = SCREEN.replace(` ${FIRST_ROW}`, " Fixture capture for the GJC ask card. This first\n paragraph mentions inline code and bold words.");
    expect(gjcAskPrompt(card(narrow), open()).question).toBe(QUESTION);
  });

  it("reads the start of a question taller than the selector's title rows only while it shows that start", () => {
    const rows = SCREEN.split("\n");
    const top = rows.indexOf(` ${FIRST_ROW}`);
    const last = rows.indexOf(` ${LAST_ROW}`);
    const cut = [...rows.slice(0, top + 2), " ▼ more", ...rows.slice(last + 1)].join("\n");
    expect(gjcAskPrompt(card(cut), open())).toMatchObject({ question: QUESTION, body: null, text_format: "markdown" });
    const scrolled = [...rows.slice(0, top), " ▲ more", ...rows.slice(top + 3, last + 1), ...rows.slice(last + 1)].join("\n");
    expect(gjcAskPrompt(card(scrolled), open()).text_format).toBeUndefined();
    const other = cut.replace("A second line in the same paragraph.", "A second line in another paragraph.");
    expect(gjcAskPrompt(card(other), open()).text_format).toBeUndefined();
  });

  it("reads one of a call's several questions by its (n/m) and the strip's keys", () => {
    const second = SCREEN.replace(LAST_ROW, `${LAST_ROW} (2/2)`).replace("↑/↓ select  enter  esc", "↑/↓ select  enter  ←/→ question  esc");
    const two = withArgs(open(), (args) => {
      args.questions.unshift({ id: "first", question: "Which region?", options: [{ label: "Seoul" }, { label: "Tokyo" }] });
    });
    expect(gjcAskPrompt(card(second), two).question).toBe(`${QUESTION} (2/2)`);
    expect(gjcAskPrompt(card(SCREEN), two).text_format).toBeUndefined();
  });

  it("leaves the card as read when no single open call provably draws the selector", () => {
    const read = card();
    const unproved: [string, OmoAsks][] = [
      ["no call", []],
      ["two calls", [...open(), { ...open()[0]!, id: "other" }]],
      ["a letter apart", withArgs(open(), (args) => { args.questions[0]!.question = QUESTION.replace("bold", "bald"); })],
      ["a mark apart", withArgs(open(), (args) => { args.questions[0]!.question = QUESTION.replace("**bold**", "**bold**!"); })],
      ["another label", withArgs(open(), (args) => { args.questions[0]!.options[1]!.label = "Remote relays"; })],
      ["another order", withArgs(open(), (args) => { args.questions[0]!.options.reverse(); })],
      ["one more option", withArgs(open(), (args) => { args.questions[0]!.options.push({ label: "Later" }); })],
      ["another recommendation", withArgs(open(), (args) => { args.questions[0]!.recommended = 1; })],
      ["no recommendation", withArgs(open(), (args) => { delete args.questions[0]!.recommended; })],
      ["multiple choice", withArgs(open(), (args) => { args.questions[0]!.multi = true; })],
      ["a numbered progress it does not draw", withArgs(open(), (args) => { args.questions.push({ question: "Next?", options: [{ label: "Yes" }] }); })],
    ];
    for (const [name, calls] of unproved) expect(gjcAskPrompt(read, calls), name).toBe(read);
  });

  it("draws no recommendation on a question of one option, as gjc does not", () => {
    const one = SCREEN.replace("│❯ Keep local socket (Recommended)", "│❯ Keep local socket").replace(/│  Remote relay.*\n│  Neither.*\n/u, "");
    const calls = withArgs(open(), (args) => { args.questions[0]!.options = [{ label: "Keep `local` socket" }]; });
    expect(card(one).options.map((option) => option.label)).toEqual(["Keep local socket", "Other (type your own)", "Esc"]);
    expect(gjcAskPrompt(card(one), calls).options[0]!.label).toBe("Keep `local` socket");
    expect(gjcAskPrompt(card(one.replace("│❯ Keep local socket", "│❯ Keep local socket (Recommended)")), calls).text_format).toBeUndefined();
  });

  it("leaves the card as read for labels the card would show alike", () => {
    const twins = SCREEN.replace("│  Remote relay", "│  Keep local socket").replace("│❯ Keep local socket (Recommended)", "│❯ Keep local socket");
    const calls = withArgs(open(), (args) => {
      args.questions[0]!.options[0]!.label = "Keep `local` socket";
      args.questions[0]!.options[1]!.label = "Keep *local* socket";
      delete args.questions[0]!.recommended;
    });
    const read = card(twins);
    expect(read.options.map((option) => option.label).slice(0, 2)).toEqual(["Keep local socket", "Keep local socket"]);
    expect(gjcAskPrompt(read, calls)).toBe(read);
  });
});
