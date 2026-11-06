import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Ovis for Mac's header in the title bar's place (app/mac/Resources/title-bar.js), run as the app runs it in a page. */
type Ask = "drag" | "zoom";
type TitleBar = (document: FakeDocument, height: number, inset: number, post: (ask: Ask) => void) => void;
const source = readFileSync(join(import.meta.dir, "..", "app", "mac", "Resources", "title-bar.js"), "utf8");
const titleBar = new Function(`${source}\nreturn ovisTitleBar;`)() as TitleBar;

/** An element as the script reads it: its classes, and `matches` for a list of tags, `[attr]` and `[attr=value]`. */
class FakeElement {
  constructor(readonly tag: string, readonly attrs: Record<string, string> = {}, readonly parentElement: FakeElement | null = null) {}
  readonly classList = { contains: (name: string) => (this.attrs.class ?? "").split(" ").includes(name) };
  matches(selectors: string): boolean {
    return selectors.split(",").map((one) => one.trim()).some((one) => {
      const attr = /^\[([\w-]+)(?:=([\w-]+))?\]$/.exec(one);
      if (!attr) return one === this.tag;
      const value = this.attrs[attr[1]!];
      return value !== undefined && (attr[2] === undefined || value === attr[2]);
    });
  }
}

type Listener = (event: { button: number; detail: number; target: FakeElement }) => void;
class FakeDocument {
  readonly properties = new Map<string, string>();
  readonly documentElement = { dataset: {} as Record<string, string>, style: { setProperty: (name: string, value: string) => { this.properties.set(name, value); } } };
  readonly listeners: { type: string; listener: Listener }[] = [];
  addEventListener(type: string, listener: Listener) {
    this.listeners.push({ type, listener });
  }
  fire(type: string, target: FakeElement, event: { button?: number; detail?: number } = {}) {
    for (const entry of this.listeners) if (entry.type === type) entry.listener({ button: 0, detail: type === "dblclick" ? 2 : 1, ...event, target });
  }
}

/** The page's header: a title on its bare surface, a button, an open menu and a focusable group in it, and the pane below. */
function page() {
  const document = new FakeDocument();
  const app = new FakeElement("div", { class: "app", tabindex: "-1" });
  const header = new FakeElement("header", { class: "app-header is-zoned" }, app);
  const title = new FakeElement("span", { class: "context-title-text" }, new FakeElement("div", { class: "context" }, header));
  const button = new FakeElement("svg", {}, new FakeElement("button", { class: "icon-button" }, header));
  const menu = new FakeElement("div", { class: "row-menu-header", role: "presentation" }, new FakeElement("div", { role: "menu" }, header));
  const switcher = new FakeElement("div", { class: "segmented", role: "group" }, header);
  const pane = new FakeElement("div", { class: "terminal-host" }, app);
  const asked: Ask[] = [];
  titleBar(document, 40, 72, (ask) => asked.push(ask));
  return { document, header, title, button, menu, switcher, pane, asked };
}

describe("Mac app title bar", () => {
  test("marks the page and hands it the bar's height and the traffic lights' right edge", () => {
    const { document } = page();
    expect(document.documentElement.dataset).toEqual({ macTitleBar: "" });
    expect(Object.fromEntries(document.properties)).toEqual({ "--mac-title-bar-h": "40px", "--mac-title-bar-inset": "72px" });
  });

  test("asks to move the window from a press on the header's bare surface, even under a focusable app", () => {
    const { document, header, title, asked } = page();
    document.fire("mousedown", title);
    document.fire("mousedown", header);
    expect(asked).toEqual(["drag", "drag"]);
  });

  test("leaves a press on a control, in an open menu, on a group of buttons or off the header to the page", () => {
    const { document, button, menu, switcher, pane, asked } = page();
    for (const target of [button, menu, switcher, pane]) document.fire("mousedown", target);
    expect(asked).toEqual([]);
  });

  test("takes neither a double click's second press nor another button as a move", () => {
    const { document, title, asked } = page();
    document.fire("mousedown", title, { detail: 2 });
    document.fire("mousedown", title, { button: 2 });
    expect(asked).toEqual([]);
  });

  test("a double click on the bare surface does what a title bar's does, and only there", () => {
    const { document, title, button, asked } = page();
    document.fire("dblclick", title);
    document.fire("dblclick", button);
    expect(asked).toEqual(["zoom"]);
  });

  test("runs once per page, as the app may run it again on the same page", () => {
    const { document, title, asked } = page();
    titleBar(document, 52, 90, (ask) => asked.push(ask));
    document.fire("mousedown", title);
    expect(asked).toEqual(["drag"]);
    expect(document.properties.get("--mac-title-bar-h")).toBe("40px");
  });
});
