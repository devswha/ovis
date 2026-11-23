import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt, waitingKindOf } from "../prompt.ts";
import { executeInteractionPlan } from "./interaction-plan.ts";
import { promptTailIsActive } from "./live.ts";
import { registry, type ReaderContext } from "./registry.ts";
import { KEY, parsedByPublicPrompt, type AnswerStep } from "./shared.ts";

// omp 19.1.1's Plan Review as recorded at 47 columns (hc read, a scratch session with a model of its own), and its
// `Exit plan mode?` box. omp draws its screens as plan-review-overlay.ts and overlay-box.ts say, which `review` follows
// for the screens nobody recorded: wider panes (the sections down the left), another region holding the keys, a comment
// on the plan, the ascii and Nerd Font presets.
const fixture = (name: string) => readFileSync(new URL(`../fixtures/omp-plan-19.1.1-${name}.txt`, import.meta.url), "utf8");
const RECORDED = fixture("actions-47");
const EXIT = fixture("exit-47");
const context: ReaderContext = { agent: "omp", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false };

type Focus = "actions" | "body" | "toc";
interface Drawn {
  width?: number;
  height?: number;
  focus?: Focus;
  cursor?: number;
  rows?: string[];
  /** the sections down the left: omp draws them from 65 columns, when the plan has two */
  toc?: boolean;
  ascii?: boolean;
  nerd?: boolean;
  footer?: string;
  /** replaces everything between the first divider and the bottom border (an annotation box, the review being applied) */
  tail?: string[];
}

const ROWS = ["Approve and execute", "Approve and compact context", "Approve and keep context (~60k / 1m)", "Save"];
const FOOTERS: Record<Focus, string> = {
  actions: "↑/↓ select · ⏎ confirm · ←/→ model · c copy · tab regions · ⎋ cancel",
  body: "↑/↓ scroll · ⇧ faster · PgUp/PgDn · g/⇧G ends · a annotate · e edit · u undo · c copy · tab regions · ⎋ cancel",
  toc: "↑/↓ section · ⏎ open · a annotate · e edit · d delete · u undo · c copy · tab regions · ⎋ cancel",
};
const PLAN = ["Add README.md to /tmp/omp-proto", "", "Context", "", "Add a README.md that explains what each file is.", "", "Approach", "", "1. Write README.md", "2. Check facts against files", "3. Leave it uncommitted"];

/** a text cut to `cols` columns, `…` where it is cut, and padded to them */
function fit(text: string, cols: number): string {
  let shown = text;
  if (Bun.stringWidth(text) > cols) {
    shown = "";
    for (const char of text) { if (Bun.stringWidth(shown + char) > cols - 1) break; shown += char; }
    shown += "…";
  }
  return shown + " ".repeat(Math.max(0, cols - Bun.stringWidth(shown)));
}

/** omp's Plan Review at `width` × `height`, drawn as plan-review-overlay.ts (render) and overlay-box.ts do */
function review({ width = 47, height = 32, focus = "actions", cursor = 0, rows = ROWS, toc, ascii = false, nerd = false, footer, tail }: Drawn = {}): string {
  const glyph = ascii ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", left: "+", right: "+", down: "+", up: "+", cursor: ">" }
    : { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", left: "├", right: "┤", down: "┬", up: "┴", cursor: nerd ? "\uf054" : "❯" };
  const column = Math.max(18, Math.min(30, Math.round(width * 0.24)));
  const sections = toc ?? (width >= 64 && width - column - 7 >= 40);
  const tee = column + 3;
  const hint = (footer ?? FOOTERS[focus]).replace("⏎", nerd ? "\u{f0311}" : "⏎");
  const actions = rows.map((row, index) => `${index === cursor ? `${glyph.cursor} ` : "  "}${row}`);
  const sliderRows = ["continue with  ◂  smol  ◀ default ▶  slow  ▸", "  ↳ Claude Opus 5.5"];
  const lower = tail ?? ["Plan mode - next step", ...sliderRows, ...actions];
  const frame = (text: string) => `${glyph.v} ${fit(text, width - 4)} ${glyph.v}`;
  const bodyHeight = Math.max(3, height - 5 - lower.length);
  const title = " Plan Review ";
  const top = sections
    ? `${glyph.tl}${glyph.h}${title}${glyph.h.repeat(tee - 2 - title.length)}${glyph.down}${glyph.h.repeat(width - 2 - tee)}${glyph.tr}`
    : `${glyph.tl}${glyph.h}${title}${glyph.h.repeat(width - 3 - title.length)}${glyph.tr}`;
  const body = Array.from({ length: bodyHeight }, (_, at) => {
    const bar = at < 2 ? "█" : glyph.v;
    if (!sections) return frame(`${fit(` ${PLAN[at] ?? ""}`, width - 6)}${bar}`);
    const left = ["Context", "Approach"][at] ?? "";
    return `${glyph.v} ${fit(`${at === 0 ? "▎" : " "}${left}`, column)} ${glyph.v} ${fit(`${PLAN[at] ?? ""}`, width - column - 7 - 1)}${bar} ${glyph.v}`;
  });
  const divider = (end: string) => `${glyph.left}${glyph.h.repeat(sections && end === "body" ? tee - 1 : width - 2)}${sections && end === "body" ? `${glyph.up}${glyph.h.repeat(width - 2 - tee)}` : ""}${glyph.right}`;
  return [top, ...body, divider("body"), ...lower.map(frame), divider("hint"), frame(hint), `${glyph.bl}${glyph.h.repeat(width - 2)}${glyph.br}`].join("\n");
}

const card = (screen: string) => parseInteractivePrompt("omp", screen);
const parsed = (screen: string) => parsedByPublicPrompt.get(card(screen)!)!;
const keys = (screen: string, index: number): string[] => answerKeys(card(screen)!, { option_index: index }).flatMap((step) => step.keys ?? []);

describe("omp's Plan Review as recorded", () => {
  it("reads the 47-column review as a plan card of named choices, none of them preselected", () => {
    const prompt = card(RECORDED)!;
    expect(prompt).toMatchObject({ agent: "omp", kind: "plan", title: "Plan review", question: "Choose how to continue", body: null, multi_select: false, custom_option_index: null });
    expect(prompt.options.map((option) => option.label)).toEqual(["Approve and execute", "Approve and compact context", "Approve and keep context (~60k / 1m)", "Save", "Cancel"]);
    expect(prompt.default_option_index).toBeUndefined();
    expect(prompt.fallback).toBeUndefined();
    expect(parsed(RECORDED)).toMatchObject({ responder: "omp-plan", selectedIndex: 0, ompPlan: { focus: "actions" } });
  });

  it("says in the bridge's own words which choices run the plan and which do not", () => {
    const prompt = card(RECORDED)!;
    expect(prompt.own_text?.title).toEqual({ key: "Plan review" });
    expect(prompt.options.map((option) => option.description)).toEqual([
      "Executes the plan now, starting fresh with just the plan",
      "Executes the plan now, after summarizing this conversation",
      "Executes the plan now, keeping this conversation",
      "Saves the plan to a file. The review stays open, and nothing runs",
      "Closes the review. Plan mode stays on",
    ]);
    expect(Object.keys(prompt.own_text?.descriptions ?? {})).toEqual(["0", "1", "2", "3", "4"]);
    expect(prompt.own_text?.labels).toEqual({ 4: { key: "Cancel" } });
  });

  it("answers each choice with the moves from the cursor's row and Enter, and Esc for Cancel", () => {
    expect([0, 1, 2, 3, 4].map((index) => keys(RECORDED, index))).toEqual([
      [KEY.enter],
      [KEY.down, KEY.enter],
      [KEY.down, KEY.down, KEY.enter],
      [KEY.down, KEY.down, KEY.down, KEY.enter],
      [KEY.escape],
    ]);
    // one key per step: each is checked on the screen before it goes out
    expect(answerKeys(card(RECORDED)!, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  it("counts the moves from wherever the cursor is, up or down", () => {
    const low = review({ cursor: 2 });
    expect([0, 1, 2, 3].map((index) => keys(low, index))).toEqual([
      [KEY.up, KEY.up, KEY.enter], [KEY.up, KEY.enter], [KEY.enter], [KEY.down, KEY.enter],
    ]);
  });

  it("keeps one card while the cursor, the region or the plan's scroll change, and another when a choice's words do", () => {
    const id = card(RECORDED)!.id;
    // the built screen and the recorded one are one card: the plan above the rows is not part of it
    expect(card(review())!.id).toBe(id);
    expect(card(review({ cursor: 2 }))!.id).toBe(id);
    expect(card(review({ focus: "body" }))!.id).toBe(id);
    expect(card(review({ width: 119, focus: "toc" }))!.id).toBe(card(review({ width: 119 }))!.id);
    expect(card(review({ rows: ROWS.map((row) => row.replace("~60k", "~64k")) }))!.id).not.toBe(id);
    expect(card(review({ rows: ["Refine plan", ...ROWS] }))!.id).not.toBe(id);
  });

  it("is the screen the omp-plan reader reads, taken for a card that waits on the user", () => {
    const reader = registry.readerFor("omp-plan");
    expect(reader).toMatchObject({ agents: ["omp"], reread: "each-move", list: "none" });
    expect(reader?.parse(RECORDED, context)?.responder).toBe("omp-plan");
    expect(promptTailIsActive(parsed(RECORDED), RECORDED)).toBe(true);
    expect(waitingKindOf(card(RECORDED)!)).toBe("permission");
  });
});

describe("omp's Plan Review at other widths and in other regions", () => {
  it("reads the same card at every width, with the sections drawn from 65 columns", () => {
    const labels = (screen: string) => card(screen)?.options.map((option) => option.label);
    for (const width of [42, 47, 64, 65, 80, 119, 200]) {
      expect(labels(review({ width })), `${width} columns`).toEqual([...ROWS, "Cancel"]);
    }
    expect(review({ width: 119 }).split("\n")[0]).toContain("┬");
    expect(review({ width: 47 }).split("\n")[0]).not.toContain("┬");
  });

  it("reads a review whose footer a narrow pane clips after its first keys", () => {
    expect(RECORDED).toContain("c cop…");
    expect(card(review({ width: 47 }))).not.toBeNull();
    expect(card(review({ width: 40 }))?.options).toHaveLength(5);
    // the region is named by the footer's first words: a footer cut inside them says none
    expect(card(review({ footer: "↑/↓ sel…" }))).toBeNull();
    expect(card(review({ footer: "↑/↓ select · ⏎ conf…" }))).not.toBeNull();
  });

  it("reads `Refine plan` as the first row once the plan has a comment", () => {
    const rows = ["Refine plan", ...ROWS];
    const screen = review({ rows, width: 119 });
    expect(card(screen)?.options.map((option) => option.label)).toEqual([...rows, "Cancel"]);
    expect(card(screen)?.options[0]?.description).toBe("Sends your comments to the agent and keeps planning");
    expect([0, 1, 4].map((index) => keys(screen, index))).toEqual([[KEY.enter], [KEY.down, KEY.enter], [KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter]]);
  });

  it("reads a review with no slider, as when one role gives one model", () => {
    const rows = ROWS.map((row) => `${row === ROWS[0] ? "❯ " : "  "}${row}`);
    const screen = review({ tail: ["Plan mode - next step", ...rows] });
    expect(card(screen)?.options.map((option) => option.label)).toEqual([...ROWS, "Cancel"]);
  });

  it("gives the rows the keys first when the plan or its sections hold them", () => {
    for (const width of [47, 119]) {
      const body = review({ width, focus: "body" });
      expect(parsed(body).ompPlan).toEqual({ focus: "body" });
      expect([0, 3].map((index) => keys(body, index)), `body, ${width}`).toEqual([[KEY.tab, KEY.enter], [KEY.tab, KEY.down, KEY.down, KEY.down, KEY.enter]]);
      // Esc closes the review from any region: no Tab for it
      expect(keys(body, 4)).toEqual([KEY.escape]);
    }
    const toc = review({ width: 119, focus: "toc" });
    expect(parsed(toc).ompPlan).toEqual({ focus: "toc" });
    expect(keys(toc, 2)).toEqual([KEY.tab, KEY.tab, KEY.down, KEY.down, KEY.enter]);
  });

  it("reads the ascii and Nerd Font presets", () => {
    const ascii = review({ ascii: true, width: 80 });
    expect(ascii.split("\n")[0]).toMatch(/^\+- Plan Review -+\+-+\+$/);
    expect(card(ascii)?.options.map((option) => option.label)).toEqual([...ROWS, "Cancel"]);
    const nerd = review({ nerd: true, width: 119, focus: "body" });
    expect(nerd).toContain("\uf054");
    expect(card(nerd)?.options).toHaveLength(5);
    expect(keys(nerd, 1)).toEqual([KEY.tab, KEY.down, KEY.enter]);
    expect(card(review({ ascii: true, width: 119 }))?.options).toHaveLength(5);
  });

  it("leaves a row cut with `…` as drawn, and still says what it does", () => {
    const clipped = review({ width: 38 });
    const labels = card(clipped)!.options.map((option) => option.label);
    expect(labels[2]).toMatch(/^Approve and keep context.*…$|^Approve and keep c.*…$/);
    expect(card(clipped)?.options[2]?.description).toBe("Executes the plan now, keeping this conversation");
  });
});

describe("what the card refuses to read", () => {
  const annotating = ["Annotate ‹Approach› · ▼", "> ▏", "⏎ save · ⇧⏎ newline · ⎋ cancel · ⌃G editor"];

  it("reads no card where a note is being typed, or the review is being applied, and leaves the screen to the terminal", () => {
    const cases = {
      "a note": review({ tail: annotating, footer: "⏎ save" }),
      "applying": review({ tail: ["Approve and execute — submitting…"], footer: "Applying your selection — this can take a moment while context is prepared." }),
    };
    for (const [name, screen] of Object.entries(cases)) {
      expect(card(screen), name).toBeNull();
      expect(registry.waits("omp", screen), name).toBe(true);
    }
    // a card from the same screen the user had open is no card for a pane that is not omp's
    expect(registry.waits("claude", RECORDED)).toBe(false);
  });

  it("reads no card without exactly one cursor, a recognised footer or the review's own header", () => {
    expect(card(review({ cursor: 9 }))).toBeNull();
    expect(card(RECORDED.replace("  Approve and compact context", "❯ Approve and compact context"))).toBeNull();
    expect(card(RECORDED.replace("Plan mode - next step", "Next step of the plan    "))).toBeNull();
    expect(card(RECORDED.replace("↑/↓ select · ⏎ confirm", "↑/↓ move   · ⏎ confirm"))).toBeNull();
    expect(card(RECORDED.replace("Plan Review", "Plan Reader"))).toBeNull();
    // a row of the plan standing where the rows are
    expect(card(review({ tail: ["Plan mode - next step", "❯ Approve and execute", "stray words"] }))).toBeNull();
  });

  it("reads no card from a review drawn above later output, nor from a screen only quoting it", () => {
    expect(card(`${RECORDED}\n π · ⬢ fixture`)).toBeNull();
    expect(card(`${RECORDED}\nsome later output`)).toBeNull();
    expect(registry.waits("omp", `${RECORDED}\nsome later output`)).toBe(false);
    const quoted = "The agent said:\n\n  Plan mode - next step\n  ❯ Approve and execute\n  Save\n\n❯\n";
    expect(card(quoted)).toBeNull();
    expect(registry.waits("omp", quoted)).toBe(false);
  });

  it("never reads a half-drawn review as a card of rows: a pane too short for the box shows no top, and waits", () => {
    const cut = RECORDED.split("\n").slice(9).join("\n");
    expect(card(cut)).toBeNull();
    expect(registry.waits("omp", cut)).toBe(true);
    expect(card(RECORDED.replace("█ │\n│                                           █ │", "█  \n│                                           █ │"))).toBeNull();
  });

  it("reads every other omp screen as before, and takes none of them for a review that waits", () => {
    const screens = ["omp-ask-18.12.6-single-120", "omp-ask-18.12.6-multi-60", "omp-approval-18.13.2-unicode-wide", "omp-handoff-18.8.7-generating-wide"];
    for (const name of screens) {
      const shown = readFileSync(new URL(`../fixtures/${name}.txt`, import.meta.url), "utf8");
      const prompt = card(shown);
      expect(prompt, name).not.toBeNull();
      expect(parsedByPublicPrompt.get(prompt!)?.responder.startsWith("omp-plan"), name).toBe(false);
      expect(registry.waits("omp", shown), name).toBe(false);
    }
  });
});

describe("omp's Exit plan mode? box", () => {
  it("reads as a two-row menu in omp's own words, answered by its moves and Enter", () => {
    const prompt = card(EXIT)!;
    expect(prompt).toMatchObject({ kind: "menu", title: "Exit plan mode?", question: "This exits plan mode without approving a plan.", body: null });
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    expect(prompt.own_text).toBeUndefined();
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(parsedByPublicPrompt.get(prompt)?.responder).toBe("omp-plan-exit");
    expect(promptTailIsActive(parsedByPublicPrompt.get(prompt)!, EXIT)).toBe(true);
    // a dialog the user opened, never one the agent waits on
    expect(waitingKindOf(prompt)).toBeUndefined();
  });

  it("follows the cursor, and reads over omp's status row as other dialogs in the editor's place do", () => {
    const onNo = EXIT.replace("│  ❯ Yes   ", "│    Yes   ").replace("│    No    ", "│  ❯ No    ");
    expect(onNo).not.toBe(EXIT);
    expect(parsedByPublicPrompt.get(card(onNo)!)?.selectedIndex).toBe(1);
    expect(answerKeys(card(onNo)!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    const status = " π · ⬢ fixture · 🗑 …/tmp/omp-proto · ◫ 5.7%/131K ⟲";
    expect(card(`${EXIT}${status}\n`)?.id).toBe(card(EXIT)!.id);
    expect(card(`${EXIT}\n${status}\n`)?.id).toBe(card(EXIT)!.id);
  });

  it("reads no card from the box left above later output, or without its footer or two rows", () => {
    expect(card(`${EXIT}\nlater output\n`)).toBeNull();
    expect(card(EXIT.replace("↑/↓ navigate  ⏎ select  ⎋ cancel", "something else"))).toBeNull();
    expect(card(EXIT.replace("│    No                                       │\n", ""))).toBeNull();
    expect(card(EXIT.replace("Exit plan mode?", "Leave plan mode?"))).toBeNull();
  });
});

/** what a pane the answer presses keys on shows and has been sent */
interface Pane {
  state: { cursor: number; focus: Focus; sent: string[] };
  screen(): string;
  send(step: AnswerStep): Promise<void>;
}

/** a pane that draws `draw(cursor, focus)` and moves as omp's keys move them; `onKey` false: the key took no effect */
function pane(draw: (cursor: number, focus: Focus) => string, start: { cursor?: number; focus?: Focus } = {}, onKey?: (key: string) => boolean): Pane {
  const state = { cursor: start.cursor ?? 0, focus: start.focus ?? ("actions" as Focus), sent: [] as string[] };
  const order: Record<Focus, Focus> = { toc: "body", body: "actions", actions: "toc" };
  const press = (key: string): void => {
    state.sent.push(key);
    if (onKey?.(key) === false) return;
    if (key === KEY.tab) state.focus = order[state.focus];
    else if (state.focus === "actions" && key === KEY.down) state.cursor = Math.min(3, state.cursor + 1);
    else if (state.focus === "actions" && key === KEY.up) state.cursor = Math.max(0, state.cursor - 1);
  };
  return {
    state,
    screen: () => draw(state.cursor, state.focus),
    send: async (step) => { for (const key of step.keys ?? []) press(key); },
  };
}

/** a key the route refuses to press: the screen it reads right before it no longer shows the review as the answer left it (prompt.ts verifyThenSend) */
class Refused extends Error {}

async function answer(shown: string, choice: number, live: Pane, active = () => true) {
  const plan = registry.readerFor("omp-plan")!.interaction!(parsed(shown));
  const send = async (step: AnswerStep): Promise<void> => {
    if (!plan.matches(live.screen())) throw new Refused();
    await live.send(step);
  };
  try {
    const result = await executeInteractionPlan(plan, choice, { rereadMoves: true, active, cancelled: () => false, read: async () => live.screen(), send });
    return { result, plan };
  } catch (error) {
    if (error instanceof Refused) return { result: "prompt_changed" as const, plan };
    throw error;
  }
}

describe("answering the review", () => {
  const draw = (width: number) => (cursor: number, focus: Focus) => review({ width, cursor, focus });

  it("lands on Save and presses Enter only there", async () => {
    const live = pane(draw(47));
    const { result, plan } = await answer(RECORDED, 3, live);
    expect(result).toBe("answered");
    expect(live.state.sent).toEqual([KEY.down, KEY.down, KEY.down, KEY.enter]);
    expect(live.state.cursor).toBe(3);
    expect(plan.cursor).toBe(3);
  });

  it("answers every choice, and presses nothing but Esc for Cancel", async () => {
    for (const [choice, expected] of [[0, [KEY.enter]], [1, [KEY.down, KEY.enter]], [2, [KEY.down, KEY.down, KEY.enter]], [4, [KEY.escape]]] as const) {
      const live = pane(draw(80));
      expect((await answer(review({ width: 80 }), choice, live)).result).toBe("answered");
      expect(live.state.sent, `choice ${choice}`).toEqual([...expected]);
    }
  });

  it("gives the rows the keys with Tab before it moves, and presses Enter only on the chosen row", async () => {
    for (const [focus, width, tabs] of [["body", 47, 1], ["body", 119, 1], ["toc", 119, 2]] as const) {
      const live = pane(draw(width), { focus });
      const { result } = await answer(review({ width, focus }), 3, live);
      expect(result, `${focus} ${width}`).toBe("answered");
      expect(live.state.sent).toEqual([...Array(tabs).fill(KEY.tab), KEY.down, KEY.down, KEY.down, KEY.enter]);
      expect(live.state.focus).toBe("actions");
      expect(live.state.cursor).toBe(3);
    }
  });

  it("sends no Enter when a key did not move the cursor, and no arrow before the rows have the keys", async () => {
    const stuck = pane(draw(47), {}, (key) => key !== KEY.down);
    expect((await answer(RECORDED, 3, stuck)).result).toBe("prompt_changed");
    expect(stuck.state.sent).not.toContain(KEY.enter);
    // a Tab that did not take: the arrows would scroll the plan
    const slow = pane(draw(47), { focus: "body" }, (key) => key !== KEY.tab);
    expect((await answer(review({ focus: "body" }), 1, slow)).result).toBe("prompt_changed");
    expect(slow.state.sent).toEqual([KEY.tab]);
  });

  it("sends no Enter when omp skips a row (one it disables), as a cursor not on the chosen row", async () => {
    const live = pane(draw(47), {}, (key) => {
      if (key === KEY.down && live.state.cursor === 1) { live.state.cursor = 3; return false; }
      return true;
    });
    expect((await answer(RECORDED, 2, live)).result).toBe("prompt_changed");
    expect(live.state.sent).not.toContain(KEY.enter);
  });

  it("sends nothing once the review is another one, answered or closed meanwhile", async () => {
    const other = pane((cursor, focus) => review({ cursor, focus, rows: ROWS.map((row) => row.replace("~60k", "~71k")) }));
    expect((await answer(RECORDED, 0, other)).result).toBe("prompt_changed");
    expect(other.state.sent).toEqual([]);
    const closed = pane(() => "π · ⬢ fixture\n");
    expect((await answer(RECORDED, 3, closed)).result).toBe("prompt_changed");
    expect(closed.state.sent).toEqual([]);
    const ended = pane(draw(47));
    expect((await answer(RECORDED, 3, ended, () => false)).result).toBe("prompt_changed");
    expect(ended.state.sent).toEqual([]);
  });

  it("does not press Esc for Cancel over a review that is not the one read", async () => {
    const live = pane(() => review({ tail: ["Annotate ‹Approach› · ▼", "> ▏", "⏎ save · ⇧⏎ newline · ⎋ cancel · ⌃G editor"], footer: "⏎ save" }));
    expect((await answer(RECORDED, 4, live)).result).toBe("prompt_changed");
    expect(live.state.sent).toEqual([]);
  });

  it("offers no choice the card has no keys for", () => {
    const plan = registry.readerFor("omp-plan")!.interaction!(parsed(RECORDED));
    expect(plan.terminalFallback(0)).toBe(false);
    expect(plan.terminalFallback(9)).toBe(true);
    expect(plan.moves(3)).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }]);
    expect(plan.commit(3)).toEqual({ keys: ["enter"] });
  });
});
