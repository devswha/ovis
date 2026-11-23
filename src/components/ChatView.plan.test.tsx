import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { parseOmpTranscript } from "../../server/transcript-records.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";

// omp 19.1.1's plan mode as one session recorded it (server/fixtures/omp-plan-19.1.1-*), read by the server's parser as the chat reads it
const SESSION = readFileSync(new URL("../../server/fixtures/omp-plan-19.1.1-session.jsonl", import.meta.url), "utf8");
const PLAN = readFileSync(new URL("../../server/fixtures/omp-plan-19.1.1-plan.md", import.meta.url), "utf8");
const turns = parseOmpTranscript(SESSION);
const FILE = "/home/user/.omp/agent/sessions/--private-tmp-omp-proto--/2026-11-23T09-52-24-789Z_01a207d2-2ed5-709e-b14c-0b91b4de8dd4/local/omp-proto-readme-plan.md";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator", "MutationObserver"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const style = { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "", backgroundColor: "" };
  const listen = { addEventListener: () => {}, removeEventListener: () => {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 } },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
});
afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = null;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});

const mount = (turn: ConversationTurn, open: ((path: string) => void) | null = null): ReactTestRenderer => {
  const row = createElement(Turn, { paneId: "p1", turn, rowKey: "r1", live: false, waiting: false, showThinking: false });
  act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(OpenFileContext.Provider, { value: open, children: row }) })); });
  return renderer!;
};
const withClass = (root: ReactTestInstance, name: string): ReactTestInstance[] => root.findAll((node) => typeof node.type === "string" && node.props.className === name);
const words = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : words(child)).join("");
const notice = (source: string, extra: Partial<Extract<ConversationPart, { kind: "notice" }>> = {}): ConversationTurn => ({
  role: "user", ts: "2026-11-23T10:00:46.988Z", parts: [{ kind: "notice", text: "x", source, ...extra }],
});
/** the turn's folded work block opened, then its first row: where the plan's call shows what it wrote */
function openFirstRow(row: ReactTestRenderer): void {
  act(() => { row.root.findByProps({ className: "work-block-head" }).props.onClick(); });
  act(() => { withClass(row.root, "work-row-head")[0]!.props.onClick(); });
}


test("says plan mode in a line of the chat's own, each state in its words, and not as a notice to open", () => {
  for (const [source, said] of [
    ["plan-on", "Plan mode on"], ["plan-on:omp-proto-readme", "Plan mode on · omp-proto-readme"], ["plan-paused", "Plan mode paused"],
    ["plan-off", "Plan mode off"], ["plan-approved:omp-proto-readme", "Plan approved · omp-proto-readme"], ["plan-ready:omp-proto-readme", "Plan ready for review · omp-proto-readme"],
  ] as const) {
    const row = mount(notice(source));
    const line = withClass(row.root, "chat-plan-notice");
    expect(line, source).toHaveLength(1);
    expect(words(line[0]!), source).toContain(said);
    expect(withClass(row.root, "chat-compact chat-notice"), source).toHaveLength(0);
    act(() => { row.unmount(); });
  }
});

test("offers the plan on disk to a proposed plan's line, and opens exactly that file", () => {
  const opened: string[] = [];
  const row = mount(notice("plan-ready:omp-proto-readme", { plan_file: FILE }), (path) => opened.push(path));
  const button = row.root.findByProps({ className: "btn btn-ghost chat-plan-notice-file" });
  expect(words(button)).toBe("View plan");
  act(() => { button.props.onClick(); });
  expect(opened).toEqual([FILE]);
});

test("offers no plan to a line that has none, or where no file can be opened", () => {
  expect(mount(notice("plan-ready:omp-proto-readme"), () => {}).root.findAllByType("button")).toHaveLength(0);
  act(() => { renderer?.unmount(); });
  expect(mount(notice("plan-ready:omp-proto-readme", { plan_file: FILE }), null).root.findAllByType("button")).toHaveLength(0);
});

test("keeps every other notice a collapsed notice", () => {
  const row = mount(notice("async-result"));
  expect(withClass(row.root, "chat-plan-notice")).toHaveLength(0);
  expect(row.root.findAllByType("details")).toHaveLength(1);
});

test("shows the recorded session's plan lines in the order the session recorded them", () => {
  const lines = turns.flatMap((turn) => turn.parts.some((part) => part.kind === "notice") ? [turn] : []);
  expect(lines).toHaveLength(4);
  const said = lines.map((turn) => words(withClass(mount(turn, () => {}).root, "chat-plan-notice")[0]!).replace(/\s*·\s*\d.*$/, ""));
  expect(said).toEqual(["Plan mode on", "Plan ready for review · omp-proto-readme", "Plan ready for review · omp-proto-readme", "Plan mode paused"]);
});

test("draws the plan a write recorded as the document it is, its sections and its diagram, and links the file it lies in", () => {
  const written = turns.find((turn) => turn.parts.some((part) => part.kind === "tool" && part.name === "write"))!;
  const opened: string[] = [];
  const row = mount(written, (path) => opened.push(path));
  openFirstRow(row);
  const document = withClass(row.root, "chat-plan-doc");
  expect(document).toHaveLength(1);
  // the plan's own headings drawn, not its source in a box
  expect(withClass(document[0]!, "markdown-h1").map(words)).toEqual(["Add README.md to /tmp/omp-proto"]);
  expect(withClass(document[0]!, "markdown-h2").map(words)).toEqual(["Context", "Approach", "Verification", "Assumptions & contingencies"]);
  expect(words(document[0]!)).not.toContain("```mermaid");
  // the diagram goes to the diagram drawer (Markdown.tsx MermaidDiagram), which shows its code until the drawing is ready
  expect(words(document[0]!)).toContain("flowchart LR");
  const link = row.root.findByProps({ className: "chat-tool-file-link" });
  expect(words(link)).toBe("local://omp-proto-readme-plan.md");
  act(() => { link.props.onClick(); });
  expect(opened).toEqual([FILE]);
});

test("draws the plan as the newest edit left it, from the plan the row carries", () => {
  const edited = turns.find((turn) => turn.parts.some((part) => part.kind === "tool" && part.name === "edit"))!;
  const row = mount(edited, () => {});
  openFirstRow(row);
  const document = withClass(row.root, "chat-plan-doc")[0]!;
  expect(words(document)).toContain("Write the README.");
  expect(withClass(document, "markdown-h2").map(words)).toContain("Approach");
  expect(PLAN).toContain("Write the README.");
});

test("draws an edit that carries no plan as its script, under a link to the plan", () => {
  const edited = structuredClone(turns.find((turn) => turn.parts.some((part) => part.kind === "tool" && part.name === "edit"))!);
  for (const part of edited.parts) if (part.kind === "tool") delete part.plan_text;
  const row = mount(edited, () => {});
  openFirstRow(row);
  expect(withClass(row.root, "chat-plan-doc-body")).toHaveLength(0);
  expect(withClass(row.root, "chat-plan-doc")).toHaveLength(1);
  expect(withClass(row.root, "chat-tool-io chat-diff")).toHaveLength(1);
  expect(words(row.root.findByProps({ className: "chat-tool-file-link" }))).toBe("local://omp-proto-readme-plan.md");
});

test("names a plan the chat cannot open without a link: a write whose result did not say where it lies", () => {
  const written = structuredClone(turns.find((turn) => turn.parts.some((part) => part.kind === "tool" && part.name === "write"))!);
  for (const part of written.parts) if (part.kind === "tool") delete part.plan_file;
  const row = mount(written, () => {});
  openFirstRow(row);
  expect(withClass(row.root, "chat-plan-doc")).toHaveLength(1);
  expect(row.root.findAllByProps({ className: "chat-tool-file-link" })).toHaveLength(0);
});

test("leaves another file's write as the source it was", () => {
  const other: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "tool", name: "write", summary: "notes", input: JSON.stringify({ path: "local://notes.md", content: "# Notes" }), output: "ok" }] };
  const row = mount(other, () => {});
  openFirstRow(row);
  expect(withClass(row.root, "chat-plan-doc")).toHaveLength(0);
  expect(row.root.findAllByType("pre").some((node) => words(node) === "# Notes")).toBe(true);
});
