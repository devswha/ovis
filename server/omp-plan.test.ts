import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ConversationTurn } from "../shared/protocol.ts";
import { ompLocalDir, ompPlanEvent, ompPlanFile, reduceOmpPlan, type OmpPlanState } from "./omp-plan.ts";
import { parseInteractivePrompt, withOmpPlanFile } from "./prompt.ts";
import { parsedByPublicPrompt } from "./dialogs/shared.ts";
import { createOmpTranscriptParser, parseOmpTranscript } from "./transcript-records.ts";

// omp 19.1.1 plan mode, as one scratch session recorded it (`/plan`, the agent's `write` of local://omp-proto-readme-plan.md and
// `propose omp-proto-readme`, a comment on the plan answered with Refine plan, an `edit` of it, `propose` again, then `/plan` and Yes):
// trimmed to the records plan mode writes, the thinking, usage and traces left out, the home folder rewritten. The plan file is the one
// the session left, and the edit's `details.newText`.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/omp-plan-19.1.1-${name}`, import.meta.url), "utf8");
const SESSION = fixture("session.jsonl");
const PLAN = fixture("plan.md");
const RECORDS = SESSION.split("\n").filter(Boolean);
const LOCAL = "/home/user/.omp/agent/sessions/--private-tmp-omp-proto--/2026-11-23T09-52-24-789Z_01a207d2-2ed5-709e-b14c-0b91b4de8dd4/local";
const PLACEHOLDER = "local://PLAN.md";
const PROPOSED = "local://omp-proto-readme-plan.md";

const root = mkdtempSync(join(tmpdir(), "ovis-omp-plan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (...records: unknown[]) => records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n";
const tools = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "tool" ? [part] : []));
const notices = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "notice" ? [part] : []));
const mode = (mode: string, data?: unknown) => ({ type: "mode_change", id: "m1", timestamp: "2026-11-23T10:00:00.000Z", mode, ...(data === undefined ? {} : { data }) });
const proposal = (extra: Record<string, unknown> = {}, inner: Record<string, unknown> = {}) => ({
  type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "Plan ready for review.\n" }], isError: false,
    details: { toolCommands: [{ tool: "propose", mode: "execute", exitCode: 0, args: { title: "s" }, inner: { planFilePath: "local://s-plan.md", title: "s", planExists: true, ...inner }, ...extra }] } },
});

describe("plan mode folded from the records", () => {
  it("follows the recorded session: on with the placeholder, the proposal naming the plan, a re-proposal with no record of its own, paused", () => {
    let state: OmpPlanState = { mode: "none" };
    const after = RECORDS.map((line) => (state = reduceOmpPlan(state, JSON.parse(line))));
    const named = after.map((entry) => entry.mode === "plan" ? entry.file : entry.mode);
    expect(named).toEqual([
      PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER,
      // the result of `propose omp-proto-readme`, three records before omp writes the second mode_change
      PROPOSED, PROPOSED, PROPOSED,
      PROPOSED, PROPOSED, PROPOSED, PROPOSED,
      // `propose` again once the plan was edited: no mode_change, the same plan
      PROPOSED, PROPOSED,
      "paused",
    ]);
  });

  it("replaces the placeholder by a later mode_change path, and by a proposal alone", () => {
    expect(reduceOmpPlan(reduceOmpPlan({ mode: "none" }, mode("plan", { planFilePath: PLACEHOLDER })), mode("plan", { planFilePath: PROPOSED }))).toEqual({ mode: "plan", file: PROPOSED });
    expect(reduceOmpPlan(reduceOmpPlan({ mode: "none" }, mode("plan", { planFilePath: PLACEHOLDER })), proposal())).toEqual({ mode: "plan", file: "local://s-plan.md" });
    // a record with no path names the placeholder
    expect(reduceOmpPlan({ mode: "none" }, mode("plan"))).toEqual({ mode: "plan", file: PLACEHOLDER });
  });

  it("takes a proposal that went through as proof plan mode is on, so a window past the mode_change still finds the plan", () => {
    expect(reduceOmpPlan({ mode: "none" }, proposal())).toEqual({ mode: "plan", file: "local://s-plan.md" });
    expect(reduceOmpPlan({ mode: "paused" }, proposal())).toEqual({ mode: "plan", file: "local://s-plan.md" });
  });

  it("takes no proposal that failed, nor a result that only looks like one", () => {
    const start: OmpPlanState = { mode: "plan", file: PLACEHOLDER };
    expect(reduceOmpPlan(start, proposal({ exitCode: 1 }))).toBe(start);
    expect(reduceOmpPlan(start, proposal({}, { planExists: false }))).toBe(start);
    expect(reduceOmpPlan(start, proposal({ tool: "grep" }))).toBe(start);
    expect(reduceOmpPlan(start, proposal({}, { planFilePath: undefined }))).toBe(start);
    const notAResult = { ...proposal(), message: { ...proposal().message, role: "assistant" } };
    expect(reduceOmpPlan(start, notAResult)).toBe(start);
    expect(reduceOmpPlan(start, { type: "message", message: { role: "toolResult", details: { toolCommands: "propose" } } })).toBe(start);
    for (const record of [null, 7, "plan", [], {}, { type: "custom", customType: "plan-mode-context" }]) expect(reduceOmpPlan(start, record)).toBe(start);
  });

  it("ends in approved with the plan's file when omp approves it (mode `none` with approvedPlanFilePath, as omp 19.1.1's source writes it)", () => {
    const approved = reduceOmpPlan({ mode: "plan", file: PROPOSED }, mode("none", { approvedPlanFilePath: PROPOSED }));
    expect(approved).toEqual({ mode: "approved", file: PROPOSED });
    // plan mode disabled with no plan approved, and a mode of another kind
    expect(reduceOmpPlan(approved, mode("none"))).toEqual({ mode: "none" });
    expect(reduceOmpPlan({ mode: "plan", file: PROPOSED }, mode("goal", { goal: "x" }))).toEqual({ mode: "none" });
    expect(reduceOmpPlan({ mode: "paused" }, mode("vibe", { previousTools: [] }))).toEqual({ mode: "none" });
  });

  it("says what a record changed, and says nothing of a plan only named, of a mode only repeated, or of another mode ending", () => {
    const on: OmpPlanState = { mode: "plan", file: PLACEHOLDER };
    const event = (before: OmpPlanState, entry: unknown) => ompPlanEvent(before, reduceOmpPlan(before, entry), entry);
    expect(event({ mode: "none" }, mode("plan", { planFilePath: PLACEHOLDER }))).toEqual({ kind: "on", file: PLACEHOLDER });
    expect(event({ mode: "paused" }, mode("plan", { planFilePath: PLACEHOLDER }))).toEqual({ kind: "on", file: PLACEHOLDER });
    expect(event(on, mode("plan", { planFilePath: PROPOSED }))).toBeNull();
    expect(event(on, proposal())).toEqual({ kind: "ready", file: "local://s-plan.md" });
    expect(event(on, mode("plan_paused"))).toEqual({ kind: "paused", file: null });
    expect(event({ mode: "paused" }, mode("plan_paused"))).toBeNull();
    expect(event(on, mode("none"))).toEqual({ kind: "off", file: null });
    expect(event({ mode: "paused" }, mode("none"))).toEqual({ kind: "off", file: null });
    expect(event({ mode: "none" }, mode("none"))).toBeNull();
    expect(event({ mode: "approved", file: PROPOSED }, mode("none"))).toBeNull();
    expect(event(on, mode("none", { approvedPlanFilePath: PROPOSED }))).toEqual({ kind: "approved", file: PROPOSED });
    expect(event(on, { type: "message", message: { role: "assistant", content: [] } })).toBeNull();
  });
});

describe("plan mode in the chat", () => {
  const turns = parseOmpTranscript(SESSION);

  it("says plan mode on, a plan ready for review (each time it is proposed), and plan mode paused, and nothing of the path update", () => {
    expect(notices(turns).map((notice) => [notice.text, notice.source])).toEqual([
      ["Plan mode on", "plan-on"],
      ["Plan ready for review · omp-proto-readme", "plan-ready:omp-proto-readme"],
      ["Plan ready for review · omp-proto-readme", "plan-ready:omp-proto-readme"],
      ["Plan mode paused", "plan-paused"],
    ]);
  });

  it("puts each notice in its place, a turn of its own between the work and what follows it", () => {
    const shape = turns.map((turn) => turn.parts.map((part) => part.kind === "tool" ? `${part.name}` : part.kind === "notice" ? (part.source ?? "notice") : part.kind).join(" "));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "user", "assistant", "user", "user", "assistant", "user", "user"]);
    expect(shape).toEqual(["plan-on", "text", "write bash", "plan-ready:omp-proto-readme", "text", "edit bash", "plan-ready:omp-proto-readme", "plan-paused"]);
  });

  it("links the proposal's notice to the plan on disk, as the write's own record says where it lies", () => {
    const ready = notices(turns).filter((notice) => notice.source?.startsWith("plan-ready"));
    expect(ready.map((notice) => notice.plan_file)).toEqual([`${LOCAL}/omp-proto-readme-plan.md`, `${LOCAL}/omp-proto-readme-plan.md`]);
    expect(notices(turns).find((notice) => notice.source === "plan-on")?.plan_file).toBeUndefined();
  });

  it("marks the plan's write and edit with the plan on disk, and the edit with the plan as it left it", () => {
    const [write, , edit] = tools(turns);
    expect(write).toMatchObject({ name: "write", plan_file: `${LOCAL}/omp-proto-readme-plan.md` });
    expect(write?.plan_text).toBeUndefined();
    expect(edit).toMatchObject({ name: "edit", plan_file: `${LOCAL}/omp-proto-readme-plan.md`, plan_text: PLAN });
    expect(PLAN).toContain("```mermaid");
    // the propose call is an ordinary bash row
    expect(tools(turns).filter((tool) => tool.name === "bash").every((tool) => tool.plan_file === undefined && tool.plan_text === undefined)).toBe(true);
  });

  it("holds the plan whole on the newest edit of it alone", () => {
    const edit = (id: string, text: string) => [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { input: "[local://omp-proto-readme-plan.md#F920]\nPUT >1:\n+x" } }], stopReason: "toolUse" } },
      { type: "message", message: { role: "toolResult", toolCallId: id, toolName: "edit", content: [{ type: "text", text: "ok" }], details: { op: "update", path: `${LOCAL}/omp-proto-readme-plan.md`, newText: text } } },
    ];
    const rows = tools(parseOmpTranscript(jsonl(...edit("a", "one"), ...edit("b", "two"), ...edit("c", "three"))));
    expect(rows.map((row) => row.plan_text)).toEqual([undefined, undefined, "three"]);
    expect(rows.every((row) => row.plan_file === `${LOCAL}/omp-proto-readme-plan.md`)).toBe(true);
    // a context clear leaves no row for a later edit to take the text from
    const cleared = tools(parseOmpTranscript(jsonl(...edit("a", "one"), { type: "custom", customType: "context_clear" }, ...edit("b", "two"))));
    expect(cleared.map((row) => row.plan_text)).toEqual(["two"]);
    // a plan too long for a row opens from its file
    const long = tools(parseOmpTranscript(jsonl(...edit("a", "x".repeat(200_001)))));
    expect(long[0]).toMatchObject({ plan_file: `${LOCAL}/omp-proto-readme-plan.md` });
    expect(long[0]?.plan_text).toBeUndefined();
  });

  it("marks no call whose own words and result disagree about the file, or that is not a plan's", () => {
    const call = (name: string, args: Record<string, unknown>, details: Record<string, unknown>) => parseOmpTranscript(jsonl(
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name, arguments: args }], stopReason: "toolUse" } },
      { type: "message", message: { role: "toolResult", toolCallId: "c", toolName: name, content: [{ type: "text", text: "ok" }], details } },
    ));
    const plan = `${LOCAL}/omp-proto-readme-plan.md`;
    const marked = (name: string, args: Record<string, unknown>, details: Record<string, unknown>) => tools(call(name, args, details))[0]?.plan_file;
    expect(marked("write", { path: "local://omp-proto-readme-plan.md", content: "x" }, { resolvedPath: plan })).toBe(plan);
    // another file than the call named, outside a `local` folder, a relative path, not a plan at all
    expect(marked("write", { path: "local://other-plan.md", content: "x" }, { resolvedPath: plan })).toBeUndefined();
    expect(marked("write", { path: "local://omp-proto-readme-plan.md", content: "x" }, { resolvedPath: "/etc/omp-proto-readme-plan.md" })).toBeUndefined();
    expect(marked("write", { path: "local://omp-proto-readme-plan.md", content: "x" }, { resolvedPath: "local/omp-proto-readme-plan.md" })).toBeUndefined();
    expect(marked("write", { path: "local://notes.md", content: "x" }, { resolvedPath: `${LOCAL}/notes.md` })).toBeUndefined();
    expect(marked("write", { path: "/tmp/omp-proto-readme-plan.md", content: "x" }, { resolvedPath: plan })).toBeUndefined();
    expect(marked("write", { path: "local://omp-proto-readme-plan.md", content: "x" }, {})).toBeUndefined();
    expect(marked("edit", { input: "[src/a.ts#AAAA]\nPUT 1:\n+x" }, { path: plan, newText: "x" })).toBeUndefined();
    expect(marked("read", { path: "local://omp-proto-readme-plan.md" }, { resolvedPath: plan })).toBeUndefined();
    // another tool's result is no plan's, whatever it says
    expect(marked("fetch", { path: "local://omp-proto-readme-plan.md" }, { resolvedPath: plan })).toBeUndefined();
  });

  it("reads a plan mode that begins before the window as it would from the start: only the notices a record itself says", () => {
    const window = parseOmpTranscript(jsonl(...RECORDS.slice(7)));
    expect(notices(window).map((notice) => notice.source)).toEqual(["plan-on:omp-proto-readme", "plan-ready:omp-proto-readme", "plan-paused"]);
  });

  it("keeps the recorded session's turns when appended one record at a time, and a half-written line takes no part", () => {
    const parser = createOmpTranscriptParser();
    let written = "";
    for (const line of RECORDS) {
      const before = parser.snapshot();
      expect(parser.snapshot(line.slice(0, -1))).toEqual(before);
      expect(parser.snapshot(line)).toEqual(parseOmpTranscript(written + line));
      parser.write(`${line}\n`);
      written += `${line}\n`;
      expect(parser.snapshot()).toEqual(parseOmpTranscript(written));
    }
    expect(parser.snapshot()).toEqual(turns);
  });

  it("leaves other omp sessions as they were: no plan, no notice, no mark", () => {
    const quiet = parseOmpTranscript(jsonl(
      { type: "message", message: { role: "user", content: "hi" } },
      mode("goal", { goal: "x" }), mode("none"),
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "w", name: "write", arguments: { path: "/tmp/a.md", content: "x" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "w", toolName: "write", content: "ok", details: { resolvedPath: "/tmp/a.md" } } },
    ));
    expect(notices(quiet)).toEqual([]);
    expect(tools(quiet)[0]).toEqual({ kind: "tool", name: "write", summary: "/tmp/a.md", input: '{\n  "path": "/tmp/a.md",\n  "content": "x"\n}', output: "ok" });
  });
});

describe("the plan behind the review", () => {
  /** an omp session folder as omp keeps it: the transcript, and `local/` beside it named like it */
  function session(name: string, records: string, files: Record<string, string | Buffer> = { "omp-proto-readme-plan.md": PLAN }): string {
    const dir = join(root, name, "sessions", "--tmp-omp-proto--");
    const transcript = join(dir, "2026-11-23T09-52-24-789Z_01a207d2-2ed5-709e-b14c-0b91b4de8dd4.jsonl");
    mkdirSync(join(dir, basename(transcript, ".jsonl"), "local"), { recursive: true });
    writeFileSync(transcript, records);
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, basename(transcript, ".jsonl"), "local", file), content);
    return transcript;
  }
  const inReview = jsonl(...RECORDS.slice(0, 13));

  it("finds the folder next to the transcript, named like it, and only for a `.jsonl`", () => {
    expect(ompLocalDir("/s/--tmp--/2026-11-23T09-52_abc.jsonl")).toBe("/s/--tmp--/2026-11-23T09-52_abc/local");
    expect(ompLocalDir("/s/--tmp--/session.json")).toBeNull();
    expect(ompLocalDir("/s/--tmp--/jsonl")).toBeNull();
  });

  it("reads the plan in review whole, from the file the last proposal named", async () => {
    const transcript = session("review", inReview);
    expect(await ompPlanFile(transcript)).toEqual({ path: join(ompLocalDir(transcript)!, "omp-proto-readme-plan.md"), text: PLAN });
  });

  it("finds the plan in the transcript's last megabyte, and none that a megabyte of later records buries", async () => {
    const filler = jsonl(...Array.from({ length: 40 }, (_, at) => ({ type: "custom", customType: "filler", data: { at, text: "x".repeat(30_000) } })));
    expect(filler.length).toBeGreaterThan(1_100_000);
    expect(await ompPlanFile(session("tail-after", jsonl(filler, ...RECORDS.slice(0, 13))))).not.toBeNull();
    expect(await ompPlanFile(session("tail-before", jsonl(...RECORDS.slice(0, 13), filler)))).toBeNull();
    // a read that starts inside a record leaves that one half out
    expect(await ompPlanFile(session("tail-cut", jsonl(`{"mode":"plan_paused","type":"mode_change","x":"${"y".repeat(1_100_000)}"}`, ...RECORDS.slice(0, 13))))).not.toBeNull();
  });

  it("reads none once plan mode is paused or approved, or when no plan was proposed and no PLAN.md was written", async () => {
    expect(await ompPlanFile(session("paused", jsonl(...RECORDS)))).toBeNull();
    expect(await ompPlanFile(session("approved", jsonl(...RECORDS.slice(0, 13), mode("none", { approvedPlanFilePath: PROPOSED }))))).toBeNull();
    expect(await ompPlanFile(session("placeholder", jsonl(RECORDS[0]!)))).toBeNull();
    expect(await ompPlanFile(session("placeholder-written", jsonl(RECORDS[0]!), { "PLAN.md": "# Plan\n\n1. One\n" }))).toMatchObject({ text: "# Plan\n\n1. One\n" });
    expect(await ompPlanFile(session("none", jsonl(mode("none"))))).toBeNull();
  });

  it("reads none for a file that is missing, blank, a folder, or lies elsewhere than the session's own local folder", async () => {
    expect(await ompPlanFile(session("missing", inReview, {}))).toBeNull();
    expect(await ompPlanFile(session("blank", inReview, { "omp-proto-readme-plan.md": " \n\n" }))).toBeNull();
    const folder = session("folder", inReview, {});
    mkdirSync(join(ompLocalDir(folder)!, "omp-proto-readme-plan.md"));
    expect(await ompPlanFile(folder)).toBeNull();
    expect(await ompPlanFile(join(root, "gone", "x.jsonl"))).toBeNull();
    expect(await ompPlanFile(session("other", inReview, { "other-plan.md": "# Other\n" }))).toBeNull();
  });

  it("reads no `local://` file but a plan's: a slug that climbs or names a folder is no plan", async () => {
    const secret = join(root, "secret-plan.md");
    writeFileSync(secret, "# not the session's\n");
    for (const file of ["local://../../../secret-plan.md", "local://../secret-plan.md", "local://a/../../secret-plan.md", "local://x-plan.md/", `local://${secret}`, "local://x-plan.md:1-2"]) {
      expect(await ompPlanFile(session(`slug-${Math.abs(file.length * 31 + file.charCodeAt(9))}`, jsonl(mode("plan", { planFilePath: file })), { "x-plan.md": "# X\n" })), file).toBeNull();
    }
  });

  it("holds the plan to what a card carries: a megabyte of plan is cut where the read stops", async () => {
    const long = await ompPlanFile(session("long", inReview, { "omp-proto-readme-plan.md": `# Long\n${"line\n".repeat(400_000)}` }));
    expect(long?.text.length).toBe(256 * 1024);
    expect(long?.text.startsWith("# Long\nline\n")).toBe(true);
  });
});

describe("the review's card with the plan", () => {
  const screen = readFileSync(new URL("./fixtures/omp-plan-19.1.1-actions-47.txt", import.meta.url), "utf8");
  const ask = readFileSync(new URL("./fixtures/omp-ask-18.12.6-single-120.txt", import.meta.url), "utf8");
  const review = () => parseInteractivePrompt("omp", screen)!;
  const found = (transcript: string | null) => async () => transcript;

  function transcript(name: string, plan: string): string {
    const dir = join(root, "card", name, "sessions", "--tmp--");
    const path = join(dir, "2026-11-23T09-52-24-789Z_card.jsonl");
    mkdirSync(join(dir, "2026-11-23T09-52-24-789Z_card", "local"), { recursive: true });
    writeFileSync(path, jsonl(...RECORDS.slice(0, 13)));
    writeFileSync(join(dir, "2026-11-23T09-52-24-789Z_card", "local", "omp-proto-readme-plan.md"), plan);
    return path;
  }

  it("brings the plan into the card, its file to open, and the plan's revision into the id", async () => {
    const path = transcript("a", PLAN);
    const card = (await withOmpPlanFile(review(), found(path)))!;
    expect(card).toMatchObject({ kind: "plan", body: PLAN.slice(0, 12_000), plan_file: join(ompLocalDir(path)!, "omp-proto-readme-plan.md") });
    expect(card.id).toMatch(new RegExp(`^${review().id}\\.[0-9a-f]{8}$`));
    expect(card.options).toEqual(review().options);
    // the same plan is the same card; another plan another one, so an answer to the first is refused
    expect((await withOmpPlanFile(review(), found(path)))!.id).toBe(card.id);
    const edited = (await withOmpPlanFile(review(), found(transcript("b", `${PLAN}\n- one more step\n`))))!;
    expect(edited.id).not.toBe(card.id);
    expect(edited.id.startsWith(`${review().id}.`)).toBe(true);
  });

  it("leaves the card as the screen shows it where there is no plan to bring: no session, no file, a lookup that fails", async () => {
    const plain = review();
    expect(await withOmpPlanFile(plain, found(null))).toBe(plain);
    expect(await withOmpPlanFile(plain, found(join(root, "card", "nowhere", "x.jsonl")))).toBe(plain);
    expect(await withOmpPlanFile(plain, async () => { throw new Error("no session"); })).toBe(plain);
    expect(await withOmpPlanFile(null, found(transcript("c", PLAN)))).toBeNull();
  });

  it("brings a plan into no card but the review's, and looks no session up for another", async () => {
    const question = parseInteractivePrompt("omp", ask)!;
    expect(parsedByPublicPrompt.get(question)?.responder).toBe("omp-question");
    let looked = 0;
    const lookup = async () => { looked += 1; return transcript("d", PLAN); };
    expect(await withOmpPlanFile(question, lookup)).toBe(question);
    expect(looked).toBe(0);
    expect(await withOmpPlanFile(review(), lookup)).not.toBe(review());
    expect(looked).toBe(1);
  });

  it("keeps the 12 000 characters a card shows, and the id from the whole plan", async () => {
    const big = `# Big\n${"word ".repeat(5_000)}`;
    const card = (await withOmpPlanFile(review(), found(transcript("e", big))))!;
    expect(card.body).toBe(big.slice(0, 12_000));
    const later = (await withOmpPlanFile(review(), found(transcript("f", `${big}tail`))))!;
    expect(later.id).not.toBe(card.id);
  });
});

