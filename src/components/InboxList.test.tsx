import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as ReactDom from "react-dom";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, InteractivePrompt } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { inboxKey, inboxOrder, type InboxFilter } from "../lib/agentInbox.ts";
import * as api from "../lib/api.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";

// the prompt read is the only request the list makes: each test answers it itself
let answerPrompt: (prompt: InteractivePrompt | null) => void = () => {};
let promptReads = 0;
let presses: string[] = [];
await mock.module("../lib/api.ts", () => ({
  ...api,
  fetchPanePromptState: () => {
    promptReads++;
    return new Promise<{ prompt: InteractivePrompt | null }>((resolve) => { answerPrompt = (prompt) => resolve({ prompt }); });
  },
}));
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
// a menu as the list hands it over (RowMenu's own drawing is RowMenu's): its props are what is read
const rowMenu = await import("./RowMenu.tsx");
function RowMenu(_props: Parameters<typeof rowMenu.RowMenu>[0]) { return null; }
await mock.module("./RowMenu.tsx", () => ({ ...rowMenu, RowMenu }));
const { InboxList } = await import("./InboxList.tsx");
const { newQuestionReads } = await import("../lib/useInboxQuestions.ts");

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const activity: SidebarActivity = {
  seqs: () => new Map(),
  status: (_machineId, pane) => pane.agent_status as AgentStatus | undefined,
};

/** the fixture's state, but with some panes in another state */
const statusOf = (moved: Record<string, AgentStatus>): SidebarActivity => ({
  seqs: () => new Map(),
  status: (_machineId, pane) => moved[pane.pane_id] ?? pane.agent_status as AgentStatus | undefined,
});

function roster(edit: (pane: HerdrPane) => HerdrPane = (pane) => pane, state: Machine["state"] = "connected"): Machine[] {
  return structuredClone(fixture).map((machine) => ({
    ...machine, state,
    snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map(edit) },
  }));
}

const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const byClass = (root: ReactTestInstance, name: string): ReactTestInstance[] =>
  root.findAll((node) => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(" ").includes(name));

describe("InboxList", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  // the page's reader (lib/useInbox.ts), which outlives each mount of the list
  let questionReads: ReturnType<typeof newQuestionReads>;
  /** whether the window is a phone's (the sheets' width) */
  let phone: boolean;

  beforeEach(() => {
    promptReads = 0;
    phone = true;
    // no case runs the reader's retry: its wait never fires, so no timer outlives a case to read into the next one
    questionReads = newQuestionReads(() => () => {});
    presses = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      history: { state: null, pushState() {}, replaceState() {}, back() {} },
      cancelAnimationFrame() {},
      location: { href: "http://localhost/", search: "" },
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      body: { nodeType: 1, children: [] },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  interface DrawOptions {
    wide?: boolean; current?: string | null; filter?: InboxFilter; query?: string; watching?: boolean; activity?: SidebarActivity; scrollTop?: number;
    /** how far the scroller can scroll at first: a scrollTop past it is clamped, as a browser does */
    scrollMax?: number;
    more?: Parameters<typeof InboxList>[0]["more"]; note?: ReactNode;
    onFilter?: (filter: InboxFilter) => void; onQuery?: (query: string) => void;
    onOpen?: (machineId: string, paneId: string) => void; onNew?: (machineId: string) => void;
  }
  // each drawn host node's stand-in, by its class (the section by its tag), and every focus call made on them
  let nodes = new Map<string, { scrollTop: number; focus(options?: FocusOptions): void }>();
  let focused: { node: string; options?: FocusOptions }[] = [];
  let scroll = { current: 0 };
  let scrollMax = Number.POSITIVE_INFINITY;
  let drawn: { machines: Machine[]; options: DrawOptions } = { machines: [], options: {} };
  const view = (machines: Machine[], options: DrawOptions): ReactElement => <SettingsProvider><PanePressContext.Provider value={(machineId, paneId) => presses.push(`${machineId}/${paneId}`)}>
    <InboxList machines={machines} activity={options.activity ?? activity} watching={options.watching ?? false} wide={options.wide ?? false} current={options.current ?? null}
      filter={options.filter ?? "all"} onFilter={options.onFilter ?? (() => {})} query={options.query ?? ""} onQuery={options.onQuery ?? (() => {})} scroll={scroll}
      onOpen={options.onOpen ?? (() => {})} onNew={options.onNew ?? (() => {})} questionReads={questionReads} more={options.more} note={options.note} />
  </PanePressContext.Provider></SettingsProvider>;
  const draw = async (machines: Machine[], options: DrawOptions = {}) => {
    nodes = new Map();
    focused = [];
    scroll = { current: options.scrollTop ?? 0 };
    scrollMax = options.scrollMax ?? Number.POSITIVE_INFINITY;
    drawn = { machines, options };
    await act(async () => {
      renderer = create(view(machines, options), { createNodeMock: (element) => {
        // by the first class, the section by its tag
        const name = element.type === "section" ? "section" : String((element.props as { className?: string }).className ?? element.type).split(" ")[0]!;
        let top = 0;
        const node = {
          get scrollTop() { return top; },
          set scrollTop(value: number) { top = Math.min(value, scrollMax); },
          focus(focusOptions?: FocusOptions) { focused.push({ node: name, options: focusOptions }); },
        };
        nodes.set(name, node);
        return node;
      } });
    });
    return renderer!.root;
  };
  /** draws again with the same props but those given */
  const redraw = async (change: { machines?: Machine[] } & DrawOptions) => {
    const { machines = drawn.machines, ...options } = change;
    drawn = { machines, options: { ...drawn.options, ...options } };
    await act(async () => { renderer!.update(view(drawn.machines, drawn.options)); });
  };
  const order = (root: ReactTestInstance) => byClass(root, "inbox-item").map((node) => node.props["data-pane"] as string);
  const twoPcs = (second: Machine["state"] = "connected"): Machine[] => {
    const [local] = roster();
    return [local!, { ...structuredClone(local!), id: "laptop", name: "Laptop", state: second }];
  };
  const anchor = { isConnected: true, focus() {}, querySelector: () => null, closest: () => null };
  const item = (root: ReactTestInstance, paneId: string, machineId = "local") => byClass(root, "inbox-item").find((node) => node.props["data-pane"] === paneId && node.props["data-machine"] === machineId)!;
  const words = (root: ReactTestInstance, paneId: string, machineId = "local") => byClass(item(root, paneId, machineId), "inbox-words").map(text);
  /** the state mark a row draws: its state, its label, and whether anything is drawn for it */
  const mark = (root: ReactTestInstance, paneId: string) => {
    const [slot] = byClass(item(root, paneId), "inbox-state");
    const [badge] = byClass(slot!, "sidebar-status");
    return { state: badge!.props["data-status"] as string, label: badge!.props["aria-label"] as string, drawn: String(slot!.props.className).split(" ").includes("is-drawn") };
  };
  const question = (asked: string, body: string | null = null) => ({
    id: "p", agent: "codex", kind: "approval", title: "Approve", question: asked, body,
    options: [], multi_select: false, custom_option_index: null,
  }) as InteractivePrompt;
  const menus = (root: ReactTestInstance) => root.findAllByType(RowMenu);

  it("draws one row per agent, in the inbox's order", async () => {
    const machines = roster();
    const root = await draw(machines);
    const keys = byClass(root, "inbox-item").map((node) => `${node.props["data-machine"]}:${node.props["data-pane"]}`);
    expect(keys).toEqual(inboxOrder(machines, activity).map(inboxKey));
    expect(keys.length).toBeGreaterThan(1);
  });

  it("has no heading and names the list for a screen reader", async () => {
    const root = await draw(roster());
    expect(root.findAll((node) => typeof node.type === "string" && /^h[1-6]$/.test(node.type))).toEqual([]);
    expect(root.findByType("section").props["aria-label"]).toBe("Agent inbox");
  });

  it("draws a row as two lines, a name and one line of words, with no chip, no place line and no button inside it", async () => {
    const root = await draw(roster());
    for (const node of byClass(root, "inbox-item")) {
      expect([byClass(node, "inbox-name").length, byClass(node, "inbox-words").length]).toEqual([1, 1]);
      expect([byClass(node, "inbox-chip").length, byClass(node, "inbox-place").length, byClass(node, "inbox-dot").length]).toEqual([0, 0, 0]);
      expect(node.findAll((inner) => inner.type === "button").length).toBe(1);
    }
  });

  it("ends a row with its state's mark and label, and draws none for an agent at rest", async () => {
    // the fixture: w1C works, w1D waits for the user; w1E is made done and not looked at, w1F waits on background work
    const machines = roster((pane) => pane.pane_id === "w1F:p1" ? { ...pane, background_wait: true } as HerdrPane : pane);
    const waiting: SidebarActivity = { seqs: () => new Map(), status: (_machineId, pane) => pane.pane_id === "w1E:p1" ? "done" : pane.pane_id === "w1F:p1" ? "waiting" : pane.agent_status as AgentStatus | undefined };
    const root = await draw(machines, { activity: waiting });
    expect(mark(root, "w1D:p1")).toEqual({ state: "blocked", label: "Agent INPUT", drawn: true });
    expect(mark(root, "w1C:p1")).toEqual({ state: "working", label: "Agent RUN", drawn: true });
    expect(mark(root, "w1F:p1")).toEqual({ state: "waiting", label: "Agent waiting on background work", drawn: true });
    expect(mark(root, "w1E:p1")).toEqual({ state: "done", label: "Agent DONE", drawn: true });
    await redraw({ activity });
    expect(mark(root, "w1E:p1")).toEqual({ state: "idle", label: "Agent READY", drawn: false });
  });

  it("draws a mark for every state when the device asks for herdr's indicators", async () => {
    const stored: Record<string, string> = { "ovis:settings": JSON.stringify({ statusIndicators: "dots" }) };
    Object.assign(window, { localStorage: { getItem: (key: string) => stored[key] ?? null, setItem() {}, removeItem() {} } });
    const root = await draw(roster());
    expect(mark(root, "w1E:p1").drawn).toBe(true);
  });

  it("says a state's word where the agent has no words of its own, and where a resting agent runs", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    expect(words(root, "w1D:p1")).toEqual(["Needs you"]);
    expect(words(root, "w1C:p1")).toEqual(["Working"]);
    expect(words(root, "w1E:p1")).toEqual(["Done"]);
    // the resting agent's workspace: its name is the pane's own label, so the place says something more
    expect(words(root, "w1F:p1")).toEqual(["docs-site"]);
  });

  it("says Ready for a resting agent whose name already says where it runs", async () => {
    const root = await draw(roster((pane) => pane.pane_id === "w1F:p1" ? { ...pane, label: "docs-site" } as HerdrPane : pane));
    expect(byClass(item(root, "w1F:p1"), "inbox-name").map(text)).toEqual(["docs-site"]);
    expect(words(root, "w1F:p1")).toEqual(["Ready"]);
  });

  it("says what a working agent is on from its plan", async () => {
    const plan = { current: "Write the export guard test", done: 1, total: 3 };
    const root = await draw(roster((pane) => pane.pane_id === "w1C:p1" ? { ...pane, plan } as HerdrPane : pane));
    expect(words(root, "w1C:p1")).toEqual(["Write the export guard test"]);
  });

  it("shows the question a waiting agent asks, on the one line", async () => {
    const root = await draw(roster());
    expect(promptReads).toBe(1);
    await act(async () => { answerPrompt(question("Run the export tests?", "bun test ./src/export.test.ts")); });
    expect(words(root, "w1D:p1")).toEqual(["Run the export tests?\nbun test ./src/export.test.ts"]);
    expect(byClass(item(root, "w1D:p1"), "inbox-words")[0]!.props.dir).toBe("auto");
  });

  it("draws the rows that ask for a look one step stronger: needs you and done, never working or resting", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    const asking = (paneId: string) => String(item(root, paneId).props.className).split(" ").includes("is-asking");
    expect([asking("w1D:p1"), asking("w1E:p1"), asking("w1C:p1"), asking("w1F:p1")]).toEqual([true, true, false, false]);
  });

  it("leads the words with the PC's name only when more than one PC is shown", async () => {
    const one = await draw(roster());
    expect(words(one, "w1C:p1")).toEqual(["Working"]);
    await act(async () => { renderer?.unmount(); });
    const root = await draw(twoPcs());
    expect(words(root, "w1C:p1", "local")).toEqual(["workstation · Working"]);
    expect(words(root, "w1C:p1", "laptop")).toEqual(["Laptop · Working"]);
  });

  it("draws a PC that is away as disabled rows that say Offline, with no mark, and open nothing", async () => {
    const opened: string[] = [];
    const root = await draw(roster(undefined, "disconnected"), { onOpen: (machineId, paneId) => opened.push(`${machineId}/${paneId}`) });
    const items = byClass(root, "inbox-item");
    expect(items.length).toBeGreaterThan(0);
    for (const node of items) {
      const row = byClass(node, "inbox-row")[0]!;
      expect(row.props.disabled).toBe(true);
      expect(String(node.props.className).split(" ")).toContain("is-offline");
      expect(byClass(node, "inbox-words").map(text)).toEqual(["Offline"]);
      expect(String(byClass(node, "inbox-state")[0]!.props.className).split(" ")).not.toContain("is-drawn");
      await act(async () => { row.props.onPointerDown({ button: 0 }); });
    }
    expect(presses).toEqual([]);
    expect(opened).toEqual([]);
    expect(byClass(root, "inbox-new").length).toBe(0);
  });

  it("says Offline after the name of a PC that is away when several PCs are shown", async () => {
    const root = await draw(twoPcs("disconnected"));
    expect(words(root, "w1D:p1", "laptop")).toEqual(["Laptop · Offline"]);
  });

  it("names a row for a screen reader: the agent's kind, its name, its state, then its words", async () => {
    const plan = { current: "Write the export guard test", done: 1, total: 3 };
    const root = await draw(roster((pane) => pane.pane_id === "w1C:p1" ? { ...pane, plan } as HerdrPane : pane));
    const label = (paneId: string) => byClass(item(root, paneId), "inbox-row")[0]!.props["aria-label"] as string;
    expect(label("w1C:p1")).toBe("Claude Code, Idempotent payments, Working, Write the export guard test");
    // a row whose words are the state's own word says it once
    expect(label("w1D:p1")).toBe("Codex, Guard the export button, Needs you");
  });

  it("opens a row's agent on its PC when pressed", async () => {
    const opened: string[] = [];
    const root = await draw(roster(), { onOpen: (machineId, paneId) => opened.push(`${machineId}/${paneId}`) });
    const row = byClass(item(root, "w1C:p1"), "inbox-row")[0]!;
    await act(async () => { row.props.onPointerDown({ button: 0 }); row.props.onClick(); });
    expect(presses).toEqual(["local/w1C:p1"]);
    expect(opened).toEqual(["local/w1C:p1"]);
  });

  it("offers the four state filters as one choice behind its round button, and tells the chosen one", async () => {
    const asked: InboxFilter[] = [];
    const root = await draw(roster(), { onFilter: (filter) => asked.push(filter) });
    const button = () => byClass(root, "inbox-filter")[0]!;
    expect(button().props["aria-label"]).toBe("Filter by state");
    expect(String(button().props.className).split(" ")).not.toContain("is-on");
    expect(menus(root).length).toBe(0);

    await act(async () => { button().props.onClick({ currentTarget: anchor }); });
    const [menu] = menus(root);
    expect(menu!.props.choice).toBe(true);
    expect(menu!.props.title).toBe("Filter by state");
    expect(menu!.props.items.map((entry: { id: string; label: string; checked: boolean }) => `${entry.id}:${entry.label}:${entry.checked}`)).toEqual(["all:All:true", "blocked:Needs you:false", "working:Working:false", "done:Done:false"]);
    await act(async () => { menu!.props.items[2].run(); });
    expect(asked).toEqual(["working"]);

    await redraw({ filter: "working" });
    expect(button().props["aria-label"]).toBe("Filter by state: Working");
    expect(String(button().props.className).split(" ")).toContain("is-on");
    expect(byClass(root, "inbox-item").map((node) => node.props["data-state"])).toEqual(["working"]);
  });

  it("says its menus are sheets at a phone's width and popovers beyond it", async () => {
    const root = await draw(twoPcs());
    expect([byClass(root, "inbox-filter")[0]!.props["aria-haspopup"], byClass(root, "inbox-new")[0]!.props["aria-haspopup"]]).toEqual(["dialog", "dialog"]);
    await act(async () => { renderer?.unmount(); });
    phone = false;
    const wide = await draw(twoPcs(), { wide: true });
    expect([byClass(wide, "inbox-filter")[0]!.props["aria-haspopup"], byClass(wide, "inbox-new")[0]!.props["aria-haspopup"]]).toEqual(["menu", "menu"]);
  });

  it("narrows the list to the rows a query matches, by name and by the words a row shows", async () => {
    const root = await draw(roster(), { query: "Guard the export button" });
    expect(order(root)).toEqual(["w1D:p1"]);
    await redraw({ query: "" });
    await act(async () => { answerPrompt(question("Allow rm of node_modules?")); });
    await redraw({ query: "node_modules" });
    expect(order(root)).toEqual(["w1D:p1"]);
  });

  it("offers Clear search only for a query, and clears it", async () => {
    const queries: string[] = [];
    const root = await draw(roster(), { onQuery: (query) => queries.push(query) });
    expect(byClass(root, "inbox-search-clear").length).toBe(0);
    await redraw({ query: "export" });
    await act(async () => { byClass(root, "inbox-search-clear")[0]!.props.onClick(); });
    expect(queries).toEqual([""]);
  });

  it("says why it draws no row: loading, none running, none matching", async () => {
    const loading = await draw([]);
    expect(byClass(loading, "inbox-empty").map(text)).toEqual(["Loading agents…"]);
    await act(async () => { renderer?.unmount(); });
    const none = await draw(roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && { ...machine.snapshot, panes: [] } })));
    expect(byClass(none, "inbox-empty").map(text)).toEqual(["No agents running"]);
    await act(async () => { renderer?.unmount(); });
    const unmatched = await draw(roster(), { query: "nothing is called this" });
    expect(byClass(unmatched, "inbox-empty").map(text)).toEqual(["No agents match"]);
    expect(byClass(unmatched, "inbox-rows").length).toBe(0);
  });

  it("offers New workspace on the one connected PC, and none to a watching device", async () => {
    const asked: string[] = [];
    const root = await draw(roster(), { onNew: (machineId) => asked.push(machineId) });
    await act(async () => { byClass(root, "inbox-new")[0]!.props.onClick({ currentTarget: anchor }); });
    expect(asked).toEqual(["local"]);
    expect(menus(root).length).toBe(0);
    await act(async () => { renderer?.unmount(); });
    expect(byClass(await draw(roster(), { watching: true }), "inbox-new").length).toBe(0);
  });

  it("asks which PC first when two are connected, starts on the one picked, and closes the sheet when the choice goes", async () => {
    const asked: string[] = [];
    const root = await draw(twoPcs(), { onNew: (machineId) => asked.push(machineId) });
    await act(async () => { byClass(root, "inbox-new")[0]!.props.onClick({ currentTarget: anchor }); });
    const [menu] = menus(root);
    expect(menu!.props.items.map((entry: { id: string; label: string }) => `${entry.id}:${entry.label}`)).toEqual(["local:workstation", "laptop:Laptop"]);
    expect(asked).toEqual([]);
    await act(async () => { menu!.props.items[1].run(); });
    expect(asked).toEqual(["laptop"]);

    await redraw({ machines: twoPcs("disconnected") });
    expect(menus(root).length).toBe(0);
    await redraw({ machines: twoPcs() });
    expect(menus(root).length).toBe(0);
  });

  it("keeps the drawn order while the focus is in the list or just after a press, and draws the new order once the focus leaves", async () => {
    const root = await draw(roster());
    const before = order(root);
    const moved = statusOf({ "w1E:p1": "blocked" });
    expect(inboxOrder(roster(), moved).map((row) => row.entry.pane.pane_id)).not.toEqual(before);
    const list = () => byClass(root, "inbox-rows")[0]!;
    await act(async () => { list().props.onFocus(); });
    await redraw({ activity: moved });
    expect(order(root)).toEqual(before);
    await act(async () => { list().props.onBlur({ relatedTarget: null, currentTarget: {} }); });
    expect(order(root)).toEqual(inboxOrder(roster(), moved).map((row) => row.entry.pane.pane_id));

    await redraw({ activity });
    await act(async () => { list().props.onPointerDown(); });
    await redraw({ activity: moved });
    expect(order(root)).toEqual(before);
  });

  it("opens at the kept scroll place with the focus on the list's section, and keeps each new place", async () => {
    const root = await draw(roster(), { scrollTop: 240 });
    expect(nodes.get("inbox-scroll")!.scrollTop).toBe(240);
    expect(focused).toEqual([{ node: "section", options: { preventScroll: true } }]);
    await act(async () => { byClass(root, "inbox-scroll")[0]!.props.onScroll({ currentTarget: { scrollTop: 610 } }); });
    expect(scroll.current).toBe(610);
  });

  it("reaches the kept scroll place once the waiting row's question is back, unless the reader scrolled meanwhile", async () => {
    await draw(roster(), { scrollTop: 167, scrollMax: 127 });
    expect(nodes.get("inbox-scroll")!.scrollTop).toBe(127);
    scrollMax = 400;
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    expect(nodes.get("inbox-scroll")!.scrollTop).toBe(167);
    expect(scroll.current).toBe(167);
    await act(async () => { renderer?.unmount(); });

    const root = await draw(roster(), { scrollTop: 167, scrollMax: 127 });
    const scroller = nodes.get("inbox-scroll")!;
    await act(async () => {
      root.findByType("section").props.onTouchStart();
      scroller.scrollTop = 40;
      byClass(root, "inbox-scroll")[0]!.props.onScroll({ currentTarget: scroller });
    });
    scrollMax = 400;
    await redraw({ activity: { ...activity, seqs: () => new Map([["w1D:p1", 5]]) } });
    expect(scroller.scrollTop).toBe(40);
    expect(scroll.current).toBe(40);
  });

  it("on a phone draws More and New workspace at its top with the shell's note between them, and the filter and the search at its foot", async () => {
    const pressed: unknown[] = [];
    const root = await draw(roster(), { more: { label: "More", expanded: false, popup: "dialog", onPress: (node) => pressed.push(node) }, note: <span className="test-note">Link copied</span> });
    const top = byClass(root, "inbox-top")[0]!;
    const classes = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && inner.parent === node).map((inner) => String(inner.props.className).split(" ").find((name) => name.startsWith("inbox-") && name !== "inbox-round") ?? String(inner.props.className));
    expect(classes(top)).toEqual(["inbox-more", "test-note", "inbox-new"]);
    expect(classes(byClass(root, "inbox-foot")[0]!)).toEqual(["inbox-filter", "inbox-search"]);
    const more = byClass(root, "inbox-more")[0]!;
    expect([more.props["aria-label"], more.props["aria-haspopup"], more.props["aria-expanded"]]).toEqual(["More", "dialog", false]);
    await act(async () => { more.props.onClick({ currentTarget: anchor }); });
    expect(pressed).toEqual([anchor]);
    expect(root.findByProps({ type: "search" }).props.placeholder).toBe("Search");
  });

  describe("as the column beside a thread", () => {
    beforeEach(() => { phone = false; });

    it("marks the open thread's row as current, and no row while none is open", async () => {
      const root = await draw(roster(), { wide: true, current: "local:w1D:p1" });
      const current = byClass(root, "inbox-row").filter((row) => row.props["aria-current"] === "true");
      expect(current.map((row) => row.parent!.props["data-pane"])).toEqual(["w1D:p1"]);
      expect(byClass(root, "is-current").map((node) => node.props["data-pane"])).toEqual(["w1D:p1"]);
      await redraw({ current: null });
      expect(byClass(root, "inbox-row").filter((row) => row.props["aria-current"] !== undefined)).toEqual([]);
      expect(byClass(root, "is-current")).toEqual([]);
    });

    it("never marks a row as current where the list is the screen", async () => {
      const root = await draw(roster(), { wide: false, current: "local:w1D:p1" });
      expect(byClass(root, "is-current")).toEqual([]);
    });

    it("draws Search and New workspace in its top row and the filter and More at its foot, the state's mark at each row's end", async () => {
      const root = await draw(roster(), { wide: true, more: { label: "More", expanded: true, popup: "menu", onPress() {} } });
      const buttons = (zone: string) => byClass(root, zone)[0]!.findAll((node) => node.type === "button").map((node) => String(node.props.className).split(" ").find((name) => name.startsWith("inbox-") && name !== "inbox-round"));
      expect(buttons("inbox-top")).toEqual(["inbox-search-toggle", "inbox-new"]);
      expect(buttons("inbox-foot")).toEqual(["inbox-filter", "inbox-more"]);
      expect(byClass(root, "inbox-more")[0]!.props["aria-expanded"]).toBe(true);
      const row = byClass(item(root, "w1D:p1"), "inbox-row")[0]!;
      // the mark is the row's last child, after the two lines, not on the words' line
      expect(byClass(row, "inbox-sub").length).toBe(0);
      expect(String((row.children.at(-1) as ReactTestInstance).props.className).split(" ")).toContain("inbox-state");
      expect(row.props.title).toBe("Guard the export button\nNeeds you");
    });

    it("opens its search field on request, focused, and puts it away with Escape once it is empty", async () => {
      const queries: string[] = [];
      const root = await draw(roster(), { wide: true, onQuery: (query) => queries.push(query) });
      const toggle = () => byClass(root, "inbox-search-toggle")[0]!;
      expect(byClass(root, "inbox-search").length).toBe(0);
      expect(toggle().props["aria-expanded"]).toBe(false);

      await act(async () => { toggle().props.onClick(); });
      expect(byClass(root, "inbox-search").length).toBe(1);
      expect(toggle().props["aria-expanded"]).toBe(true);
      expect(focused.map((call) => call.node)).toContain("input");

      // with words in it, Escape takes the words and the field stays; empty, Escape puts it away
      await redraw({ query: "export" });
      const field = () => root.findByProps({ type: "search" });
      await act(async () => { field().props.onKeyDown({ key: "Escape", preventDefault() {} }); });
      expect(queries).toEqual([""]);
      await redraw({ query: "" });
      expect(byClass(root, "inbox-search").length).toBe(1);
      await act(async () => { field().props.onKeyDown({ key: "Escape", preventDefault() {} }); });
      expect(byClass(root, "inbox-search").length).toBe(0);
    });

    it("keeps its search field shown while a query narrows the list, whatever its button is asked", async () => {
      const root = await draw(roster(), { wide: true, query: "export" });
      expect(byClass(root, "inbox-search").length).toBe(1);
      await act(async () => { byClass(root, "inbox-search-toggle")[0]!.props.onClick(); });
      expect(byClass(root, "inbox-search").length).toBe(1);
    });
  });
});
