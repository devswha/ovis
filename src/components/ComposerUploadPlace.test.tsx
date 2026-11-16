import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

// #3216: a pasted or picked file's path goes where the paste or pick was made, however the text changes while it uploads
const pane = "upload-place-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null, getElementById: () => null },
    // a frame runs at once: a path waiting for a composition to end is placed in the next one
    requestAnimationFrame: (frame: (time: number) => void) => { frame(0); return 1; },
    cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

/** the message box as the browser holds it: its value and selection, which the test sets as a user would */
type Box = { value: string; selectionStart: number; selectionEnd: number; selectionDirection: "none"; focused: number; style: Record<string, string>; listeners: Map<string, () => void>; focus(): void; setSelectionRange(start: number, end: number): void; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string): void };
let element: Box;
const uploads = new Map<string, { resolve: (path: string) => void; reject: (error: unknown) => void }>();
const path = (name: string) => `/tmp/proj/.ovis/${name}-20261116-101010-0123abcd.png`;

let props: ComposerProps;
/** `restored`: a cancelled send the agent put back in its box, which fills the empty composer */
async function open(restored: string | null = null): Promise<void> {
  props = {
    paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: () => true, onAbort() {},
    onUploadImage: (file) => new Promise<string>((resolve, reject) => { uploads.set(file.name.replace(/\.png$/u, ""), { resolve, reject }); }),
  };
  element = { value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none", focused: 0, style: {}, listeners: new Map(), focus() { this.focused++; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }, addEventListener(type, listener) { this.listeners.set(type, listener); }, removeEventListener(type) { this.listeners.delete(type); } };
  const measure = { style: {}, scrollHeight: 0 };
  await act(async () => {
    renderer = create(<Composer {...props} restored={restored} />, { createNodeMock: (node) => node.type !== "textarea" ? null : (node.props as { onKeyDown?: unknown }).onKeyDown ? element : measure });
  });
}
const box = () => renderer!.root.findAll((node) => node.type === "textarea" && node.props.onKeyDown !== undefined)[0]!;
const png = (name: string) => new File([new Uint8Array([1])], `${name}.png`, { type: "image/png" });
/** the user's edit: the box's value and caret, then its change event */
async function type(value: string, caret = value.length): Promise<void> {
  Object.assign(element, { value, selectionStart: caret, selectionEnd: caret });
  await act(async () => { box().props.onChange({ target: element }); });
}
/** the user's selection, as the box reports it before the next edit */
async function select(start: number, end = start): Promise<void> {
  Object.assign(element, { selectionStart: start, selectionEnd: end });
  await act(async () => { box().props.onSelect({ currentTarget: element }); });
}
/** the draft written from elsewhere: another tab, as a storage event brings it */
async function writeElsewhere(value: string): Promise<void> {
  await act(async () => { composerDrafts.set(draftKey, value); });
}
async function compose(phase: "start" | "end"): Promise<void> {
  await act(async () => {
    if (phase === "start") box().props.onCompositionStart();
    else {
      box().props.onCompositionEnd();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}
/** a click or tap in the text, which puts the caret at `at` */
async function click(at: number): Promise<void> {
  Object.assign(element, { selectionStart: at, selectionEnd: at });
  await act(async () => { box().props.onClick({ currentTarget: element }); });
}
/** each tile's state, as its class draws it ("unplaced": the warning glyph, its path in no message) */
const badges = () => renderer!.root.findAll((node) => typeof node.props.className === "string" && node.props.className.startsWith("composer-attachment is-")).map((node) => (node.props.className as string).slice("composer-attachment is-".length));
const sendOff = () => renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Send message").props.disabled as boolean;
const button = (name: string) => renderer!.root.find((node) => node.type === "button" && (node.props["aria-label"] === name || node.props.children === name));
async function paste(at: number, ...names: string[]): Promise<void> {
  Object.assign(element, { selectionStart: at, selectionEnd: at });
  await act(async () => {
    box().props.onPaste({ currentTarget: element, clipboardData: { getData: () => "", items: names.map((name) => ({ kind: "file", getAsFile: () => png(name) })) }, preventDefault() {} });
  });
}
async function pick(at: number, ...names: string[]): Promise<void> {
  Object.assign(element, { selectionStart: at, selectionEnd: at });
  const input = renderer!.root.find((node) => node.type === "input" && node.props.type === "file");
  await act(async () => { input.props.onChange({ currentTarget: { files: names.map(png), value: "" } }); });
}
async function finish(name: string): Promise<void> {
  await act(async () => { uploads.get(name)!.resolve(path(name)); });
}
const tiles = () => renderer!.root.findAll((node) => typeof node.props.className === "string" && node.props.className.startsWith("composer-attachment is-")).length;

it("puts a pasted image's path where it was pasted, after edits made before and after it while it uploads", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  await type("before after more");
  await type("so before after more", 2);
  // the user has selected "so", and the box is not focused: both stay as they are
  Object.assign(element, { selectionStart: 0, selectionEnd: 2 });
  await finish("shot");
  expect(box().props.value).toBe(`so before @${path("shot")} after more`);
  expect([element.selectionStart, element.selectionEnd, element.focused]).toEqual([0, 2, 0]);
});

it("keeps the selected text and moves the selection with it when the path goes before it", async () => {
  await open();
  await type("before after", 7);
  Object.assign(element, { selectionStart: 7, selectionEnd: 12 });
  await act(async () => {
    box().props.onPaste({ currentTarget: element, clipboardData: { getData: () => "", items: [{ kind: "file", getAsFile: () => png("shot") }] }, preventDefault() {} });
  });
  await finish("shot");
  const value = box().props.value as string;
  expect(value).toBe(`before @${path("shot")} after`);
  expect(value.slice(element.selectionStart, element.selectionEnd)).toBe("after");
});

it("keeps the order of files picked together, however their uploads finish", async () => {
  await open();
  await type("look at these please", 14);
  await pick(14, "one", "two");
  await finish("two");
  await finish("one");
  expect(box().props.value).toBe(`look at these @${path("one")} @${path("two")} please`);
});

it("waits for a Korean IME composition to end, then goes before the syllable composed at its place", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  await compose("start");
  await type("before ㅎafter", 8);
  await type("before 하after", 8);
  await finish("shot");
  await type("before 한after", 8);
  expect(box().props.value).toBe("before 한after");
  await compose("end");
  expect(box().props.value).toBe(`before @${path("shot")} 한after`);
});

it("never puts the path of an upload started in a draft cleared elsewhere into the new one, and keeps its file", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  expect(tiles()).toBe(1);
  await writeElsewhere("");
  await type("new draft");
  await finish("shot");
  expect(box().props.value).toBe("new draft");
  expect(tiles()).toBe(1);
});

it("never puts the path of an upload started in a draft typed over whole into the new one, whatever they share", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  // the whole draft selected, then typed over: the browser's beforeinput sees the selection it replaces
  Object.assign(element, { selectionStart: 0, selectionEnd: 12 });
  await act(async () => { element.listeners.get("beforeinput")?.(); });
  await type("brand new after");
  await finish("shot");
  expect(box().props.value).toBe("brand new after");
  // the file is never thrown away by an edit in the box: it stays, saying its path is in no message
  expect(badges()).toEqual(["unplaced"]);
});

it("moves a later paste's place once for each path placed before it, whichever upload finishes first", async () => {
  await open();
  await type("one two three", 13);
  await paste(8, "late");
  await paste(4, "early");
  await finish("early");
  await finish("late");
  expect(box().props.value).toBe(`one @${path("early")} two @${path("late")} three`);
});

it("keeps the order of files picked together inside a leading slash command", async () => {
  await open();
  await type("/review the menu", 3);
  await pick(3, "one", "two");
  await finish("one");
  await finish("two");
  expect(box().props.value).toBe(`/review @${path("one")} @${path("two")} the menu`);
});

it("takes a removed attachment's path out of the text when it was placed before a line break", async () => {
  await open();
  await type("before\nafter", 6);
  await paste(6, "shot");
  await finish("shot");
  expect(box().props.value).toBe(`before @${path("shot")}\nafter`);
  const remove = renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove shot.png");
  await act(async () => { remove.props.onClick(); });
  expect(box().props.value).toBe("before\nafter");
  expect(tiles()).toBe(0);
});

it("keeps the user's own space when a path placed after it, before a line break, is removed", async () => {
  await open();
  await type("before \nafter", 7);
  await paste(7, "shot");
  await finish("shot");
  expect(box().props.value).toBe(`before @${path("shot")}\nafter`);
  const remove = renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove shot.png");
  await act(async () => { remove.props.onClick(); });
  expect(box().props.value).toBe("before \nafter");
});

it("puts a retried upload's path where the paste was made", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  await act(async () => { uploads.get("shot")!.reject(new Error("offline")); });
  await type("so before after", 2);
  const retry = renderer!.root.find((node) => node.type === "button" && node.props.children === "Try again");
  await act(async () => { retry.props.onClick(); });
  await finish("shot");
  expect(box().props.value).toBe(`so before @${path("shot")} after`);
});

// an edit made in the box never discards a file: its place goes where the edit began
it("keeps a file pasted during a Korean composition in an empty box, and puts its path before the syllable", async () => {
  await open();
  await compose("start");
  await type("ㅎ", 1);
  await paste(1, "shot");
  await type("하", 1);
  await type("한", 1);
  await finish("shot");
  await compose("end");
  expect(box().props.value).toBe(`@${path("shot")} 한`);
  expect(tiles()).toBe(1);
});

it("keeps a file whose draft was backspaced empty, and puts its path where the user next puts the caret", async () => {
  await open();
  await type("hi");
  await paste(2, "shot");
  await type("h", 1);
  await type("", 0);
  await type("look at this");
  await finish("shot");
  expect(box().props.value).toBe("look at this");
  expect(badges()).toEqual(["unplaced"]);
  await click(8);
  expect(box().props.value).toBe(`look at @${path("shot")} this`);
  expect(badges()).toEqual(["ready"]);
});

it("keeps a failed upload and its Try again when the box is emptied", async () => {
  await open();
  await type("hi");
  await paste(2, "shot");
  await act(async () => { uploads.get("shot")!.reject(new Error("offline")); });
  await type("h", 1);
  await type("", 0);
  await act(async () => { button("Try again").props.onClick(); });
  await finish("shot");
  expect(badges()).toEqual(["unplaced"]);
  await type("look", 4);
  await click(4);
  expect(box().props.value).toBe(`look @${path("shot")} `);
});

it("keeps a selection that ends at the place before the path, and waits while one spans it", async () => {
  await open();
  await type("look at this");
  await paste(12, "shot");
  await select(8, 12);
  await finish("shot");
  expect(box().props.value).toBe(`look at this @${path("shot")} `);
  expect(box().props.value.slice(element.selectionStart, element.selectionEnd)).toBe("this");

  await type("before after", 7);
  await paste(7, "next");
  await select(3, 10);
  await finish("next");
  expect(box().props.value).toBe("before after");
  // typed over: the path goes where the edit began, and nothing deletes it
  await type("befXer", 4);
  expect(box().props.value).toBe(`bef @${path("next")} Xer`);
});

it("takes a removed attachment's path out of the text when it was placed before a tab", async () => {
  await open();
  await type("before\tafter", 6);
  await paste(6, "shot");
  await finish("shot");
  expect(box().props.value).toBe(`before @${path("shot")}\tafter`);
  await act(async () => { button("Remove shot.png").props.onClick(); });
  expect(box().props.value).toBe("before\tafter");
});

it("never puts the path inside an emoji typed over the place", async () => {
  await open();
  await type("x\u{1F600}a");
  await paste(3, "shot");
  await select(1, 4);
  await type("x\u{1F603}", 3);
  await type("x\u{1F603}b", 4);
  await finish("shot");
  // the emoji typed over the place stays whole: no half of it is cut off by the path
  expect(box().props.value).toBe(`x @${path("shot")} \u{1F603}b`);
});

it("follows the copy of repeated words the caret typed in", async () => {
  await open();
  await type("go go now", 6);
  await paste(6, "shot");
  await select(0);
  await type("go go go now", 3);
  await finish("shot");
  expect(box().props.value).toBe(`go go go @${path("shot")} now`);
});

it("never puts the path into a draft another tab replaced, whatever the two share", async () => {
  await open();
  await type("hello world");
  await paste(11, "shot");
  await writeElsewhere("hello other");
  await finish("shot");
  expect(box().props.value).toBe("hello other");
  expect(tiles()).toBe(1);
});

it("says a file whose draft was replaced elsewhere is not in the message, holds Send, and puts its path where the user clicks", async () => {
  await open();
  await type("hello world");
  await paste(11, "shot");
  await writeElsewhere("hello other");
  await finish("shot");
  expect(badges()).toEqual(["unplaced"]);
  expect(sendOff()).toBe(true);
  await click(5);
  expect(box().props.value).toBe(`hello @${path("shot")} other`);
  expect(badges()).toEqual(["ready"]);
  expect(sendOff()).toBe(false);
  // placed late, it is removed as it went in
  await act(async () => { button("Remove shot.png").props.onClick(); });
  expect(box().props.value).toBe("hello other");
});

it("never puts a dropped file's path into a draft another tab replaced", async () => {
  await open();
  await type("hello");
  await act(async () => { renderer!.root.find((node) => node.props.onDrop !== undefined).props.onDrop({ preventDefault() {}, dataTransfer: { files: [png("shot")] } }); });
  await writeElsewhere("other");
  await finish("shot");
  expect(box().props.value).toBe("other");
});

it("puts a path that waited on a restored /command in once the untouched fill is cleared", async () => {
  await open("/compact");
  expect(box().props.value).toBe("/compact");
  await pick(8, "shot");
  await finish("shot");
  expect(box().props.value).toBe("/compact");
  await act(async () => { renderer!.update(<Composer {...props} restored={null} />); });
  expect(box().props.value).toBe(`@${path("shot")} `);
});

it("puts a file picked during an IME composition before the syllable being composed", async () => {
  await open();
  await type("abc ", 4);
  await compose("start");
  await type("abc ㅎ", 5);
  await pick(5, "shot");
  await type("abc 한", 5);
  await finish("shot");
  await compose("end");
  expect(box().props.value).toBe(`abc @${path("shot")} 한`);
});

it("puts a file picked while a syllable is being composed in an empty box in when the IME commits it, with no click", async () => {
  await open();
  await compose("start");
  await type("한", 1);
  await pick(1, "shot");
  await finish("shot");
  // the commit, as Chromium sends it: a beforeinput over the candidate it selects, which it may clear before writing the syllable
  Object.assign(element, { selectionStart: 0, selectionEnd: 1 });
  await act(async () => { element.listeners.get("beforeinput")?.(); });
  await type("", 0);
  await type("한", 1);
  await compose("end");
  expect(box().props.value).toBe(`@${path("shot")} 한`);
  expect(badges()).toEqual(["ready"]);
});
