import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts, onDraftStorage } from "../lib/composerDraft.ts";
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
  composerDrafts.set(draftKey, "", "replace");
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "", "replace");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

/** the message box as the browser holds it: its value and selection, which the test sets as a user would */
type Box = { value: string; selectionStart: number; selectionEnd: number; selectionDirection: "none"; focused: number; style: Record<string, string>; focus(): void; setSelectionRange(start: number, end: number): void };
let element: Box;
const uploads = new Map<string, { resolve: (path: string) => void; reject: (error: unknown) => void }>();
const path = (name: string) => `/tmp/proj/.ovis/${name}-20261116-101010-0123abcd.png`;

let props: ComposerProps;
/** `restored`: a cancelled send the agent put back in its box, which fills the empty composer; `onSend`: how a send is answered */
async function open(restored: string | null = null, onSend: ComposerProps["onSend"] = () => true): Promise<void> {
  props = {
    paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend, onAbort() {},
    onUploadImage: (file) => new Promise<string>((resolve, reject) => { uploads.set(file.name.replace(/\.png$/u, ""), { resolve, reject }); }),
  };
  element = { value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none", focused: 0, style: {}, focus() { this.focused++; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
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
/** the draft written from elsewhere (a send's acknowledgement, a new or restored draft): a write that is no edit of this box */
async function writeElsewhere(value: string): Promise<void> {
  await act(async () => { composerDrafts.set(draftKey, value, "replace"); });
}
/** another tab's writes, read here at once as its storage event brings them */
async function writeInOtherTab(...values: string[]): Promise<void> {
  await act(async () => {
    for (const value of values) paneLifetimes.paneStorage.setItem(draftKey, value);
    composerDrafts.refresh(draftKey);
  });
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
/** each tile's state, as its class draws it */
const badges = () => renderer!.root.findAll((node) => typeof node.props.className === "string" && node.props.className.startsWith("composer-attachment is-")).map((node) => (node.props.className as string).slice("composer-attachment is-".length));
/** what the polite live region last said, for assistive tech */
const announced = () => renderer!.root.findAll((node) => node.props["aria-live"] === "polite").map((node) => node.findAll((child) => typeof child.type === "string" && child.type === "span").map((span) => span.children.join("")).join("")).join("");
/** what the status line under the box says */
const hint = () => renderer!.root.findAll((node) => typeof node.props.className === "string" && node.props.className.startsWith("composer-status-hint")).map((node) => node.children.join("")).join("");
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

it("never puts the path of an upload started in a draft cleared elsewhere into the new one, and detaches its file", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  expect(tiles()).toBe(1);
  await writeElsewhere("");
  await type("new draft");
  await finish("shot");
  expect(box().props.value).toBe("new draft");
  expect(tiles()).toBe(0);
  // only detached from this message, said in one line for assistive tech, with nothing new on screen
  expect(announced()).toBe("shot.png detached from the message");
  expect(hint()).toBe("");
});

it("puts the path of an upload whose draft was typed over whole before the new words, never inside one", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  // the whole draft selected, then typed over: an edit in the box, so the place goes where it began
  await select(0, 12);
  await type("b", 1);
  await type("brand new after");
  await finish("shot");
  expect(box().props.value).toBe(`@${path("shot")} brand new after`);
  expect(badges()).toEqual(["ready"]);
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

it("keeps a file whose draft was backspaced empty, and puts its path before what is typed next", async () => {
  await open();
  await type("hi");
  await paste(2, "shot");
  await type("h", 1);
  await type("", 0);
  await type("look at this");
  await finish("shot");
  expect(box().props.value).toBe(`@${path("shot")} look at this`);
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
  expect(box().props.value).toBe(`@${path("shot")} `);
});

it("keeps a selection that ends at the place before the path, and puts the path before one that spans it, Send not held", async () => {
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
  // nothing waits: the path goes before the selection's first word, the selection stays on the same text
  const placed = `@${path("next")} `;
  expect(box().props.value).toBe(`${placed}before after`);
  expect(box().props.value.slice(element.selectionStart, element.selectionEnd)).toBe("ore aft");
  expect(badges()).toEqual(["ready"]);
  expect(sendOff()).toBe(false);
  // typed over: the selected text goes, and the path stays whole
  await type(`${placed}befXer`, placed.length + 4);
  expect(badges()).toEqual(["ready"]);
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
  expect(tiles()).toBe(0);
});

it("detaches a file whose draft was replaced elsewhere, in one line for assistive tech, and holds no Send", async () => {
  await open();
  await type("hello world");
  await paste(11, "shot");
  await writeElsewhere("hello other");
  await finish("shot");
  expect(tiles()).toBe(0);
  // only detached from this message, said in one line for assistive tech, with nothing new on screen
  expect(announced()).toBe("shot.png detached from the message");
  expect(hint()).toBe("");
  expect(sendOff()).toBe(false);
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
  // the commit, as Chromium sends it: the candidate it selects may be cleared before the syllable is written
  Object.assign(element, { selectionStart: 0, selectionEnd: 1 });
  await type("", 0);
  await type("한", 1);
  await compose("end");
  expect(box().props.value).toBe(`@${path("shot")} 한`);
  expect(badges()).toEqual(["ready"]);
});

// a selection that ends at the place, typed over while the file uploads: the path goes before the new word
it("puts the path before a word typed over a selection that ends at the place, never inside it", async () => {
  await open();
  await type("fix this bug", 8);
  await paste(8, "shot");
  await select(4, 8);
  await type("fix t bug", 5);
  await type("fix that bug", 8);
  await finish("shot");
  expect(box().props.value).toBe(`fix @${path("shot")} that bug`);
});

it.each([["a composing keyboard", ["n", "ne", "new"]], ["a Korean IME", ["한", "한국"]]] as const)("puts the path before a whole draft typed over with %s, never inside the first word", async (_name, steps) => {
  await open();
  await type("look at this", 12);
  await paste(12, "shot");
  await select(0, 12);
  await compose("start");
  for (const step of steps) await type(step, step.length);
  await compose("end");
  await finish("shot");
  expect(box().props.value).toBe(`@${path("shot")} ${steps.at(-1)}`);
});

// a draft another tab rewrites is replaced, even when the new text begins with the old one
it("never puts the path into a draft another tab rewrote in writes read at once, though it begins with the old one", async () => {
  await open();
  await type("hello", 5);
  await paste(5, "shot");
  await writeInOtherTab("", "hello, a new unrelated question");
  await finish("shot");
  expect(box().props.value).toBe("hello, a new unrelated question");
  expect(tiles()).toBe(0);
});

it("never puts the path of a file picked into a restored message, cleared since, into what is typed next", async () => {
  await open("please retry this");
  await pick(17, "shot");
  await act(async () => { renderer!.update(<Composer {...props} restored={null} />); });
  expect(box().props.value).toBe("");
  await type("brand new");
  await finish("shot");
  expect(box().props.value).toBe("brand new");
  expect(tiles()).toBe(0);
});

it("keeps the path of a quote added after the pick, as an append that moves no place", async () => {
  await open();
  await type("look at this", 8);
  await paste(8, "shot");
  await act(async () => { composerDrafts.set(draftKey, "look at this\n\n> quoted", "append"); });
  await finish("shot");
  expect(box().props.value).toBe(`look at @${path("shot")} this\n\n> quoted`);
});

// once placed, the tile follows the path: when it is gone from the message, the tile says so and Send waits
it.each([
  // "at @path" selected and typed over with "the cat": " this" stays
  ["a selection over it typed over", async (value: string) => { await select(5, value.length - 5); await type(`look the cat${value.slice(-5)}`, 12); }],
  ["backspace through it", async (value: string) => { const cut = value.indexOf(".png"); await type(value.slice(0, cut) + value.slice(cut + 1), cut); }],
  ["the whole draft typed over", async (value: string) => { await select(0, value.length); await type("n", 1); await type("new words"); }],
  ["another tab replacing the draft", async () => { await writeInOtherTab("something else"); }],
] as const)("detaches the file once its placed path is no longer in the message, %s; nothing new on screen, Send not held", async (_name, edit) => {
  await open();
  await type("look at this", 8);
  await paste(8, "shot");
  await finish("shot");
  expect(badges()).toEqual(["ready"]);
  await edit(box().props.value as string);
  expect(tiles()).toBe(0);
  expect(announced()).toBe("shot.png detached from the message");
  expect(hint()).toBe("");
  expect(sendOff()).toBe(false);
});

it("removes the path the upload put in, not the user's own copy of it earlier", async () => {
  await open();
  await type(`see @${path("shot")} x`);
  await paste((box().props.value as string).length, "shot");
  await finish("shot");
  expect(box().props.value).toBe(`see @${path("shot")} x @${path("shot")} `);
  await act(async () => { button("Remove shot.png").props.onClick(); });
  expect(box().props.value).toBe(`see @${path("shot")} x`);
});


// a send's acknowledgement is this box's own edit: a path placed while the send was on its way stays attached
it("keeps a path placed while a send was on its way attached once the send is acknowledged, and Remove takes it out", async () => {
  let acknowledge!: (ok: boolean) => void;
  await open(null, () => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
  await type("first");
  await act(async () => { button("Send message").props.onClick(); });
  await type("first second");
  await paste(12, "shot");
  await finish("shot");
  expect(box().props.value).toBe(`first second @${path("shot")} `);
  await act(async () => { acknowledge(true); });
  expect(box().props.value).toBe(` second @${path("shot")} `);
  expect(badges()).toEqual(["ready"]);
  await act(async () => { button("Remove shot.png").props.onClick(); });
  expect(box().props.value).toBe(" second");
});

// every storage event on the draft is another tab's write, even one that leaves the same text
it("never puts the path into a draft another tab cleared and retyped the same, both read at once", async () => {
  await open();
  await type("hello", 5);
  await paste(5, "shot");
  await act(async () => {
    paneLifetimes.paneStorage.removeItem(draftKey);
    paneLifetimes.paneStorage.setItem(draftKey, "hello");
    onDraftStorage(draftKey);
    onDraftStorage(draftKey);
  });
  await finish("shot");
  expect(box().props.value).toBe("hello");
  expect(tiles()).toBe(0);
});

it("keeps a space the user typed where the upload's own space was, when the file is removed", async () => {
  await open();
  await paste(0, "shot");
  await finish("shot");
  const placed = box().props.value as string;
  await type(placed.slice(0, -1), placed.length - 1);
  await type(`${placed.slice(0, -1)} more`, placed.length + 4);
  await act(async () => { button("Remove shot.png").props.onClick(); });
  expect(box().props.value).toBe(" more");
});

it("puts the path before a word typed on straight from where it was pasted, never inside it", async () => {
  await open();
  await type("scree", 5);
  await paste(5, "shot");
  await type("screen", 6);
  await type("screenshot", 10);
  await finish("shot");
  expect(box().props.value).toBe(`@${path("shot")} screenshot`);
});

// an undo of the edit that took a file out brings its path and its tile back
it.each([
  ["a character deleted from the path", (value: string) => { const cut = value.indexOf(".png"); return [value.slice(0, cut) + value.slice(cut + 1), cut] as const; }],
  ["the whole draft typed over", () => ["new words", 9] as const],
] as const)("brings the path and its tile back when %s is undone", async (_name, erase) => {
  await open();
  await type("look at this", 8);
  await paste(8, "shot");
  await finish("shot");
  const whole = box().props.value as string;
  const [erased, caret] = erase(whole);
  await select(0, whole.length);
  await type(erased, caret);
  expect(tiles()).toBe(0);
  // the undo: the text as it was before that edit
  await type(whole, whole.length);
  expect(box().props.value).toBe(whole);
  expect(badges()).toEqual(["ready"]);
  expect(hint()).toBe("");
  await act(async () => { button("Remove shot.png").props.onClick(); });
  expect(box().props.value).toBe("look at this");
});

it("leaves what is left of a partly deleted path as the user's own text, and sends nothing until Send, then as shown", async () => {
  const sent: string[] = [];
  await open(null, (message) => { sent.push(message); return true; });
  await type("look at this", 8);
  await paste(8, "shot");
  await finish("shot");
  const whole = box().props.value as string;
  const cut = whole.indexOf(".png");
  const partly = whole.slice(0, cut) + whole.slice(cut + 1);
  await type(partly, cut);
  expect(tiles()).toBe(0);
  expect(box().props.value).toBe(partly);
  expect(sent).toEqual([]);
  await act(async () => { button("Send message").props.onClick(); });
  expect(sent).toEqual([partly]);
});

// a paste or pick with the caret inside a placed path puts the new path at the front of that one; both stay whole
it.each([["pasted", "paste"], ["picked", "pick"]] as const)("keeps a placed path whole when another file is %s inside it, and Remove takes out only each file's own path", async (_name, how) => {
  await open();
  await type("see ", 4);
  await paste(4, "a");
  await finish("a");
  const a = `@${path("a")}`;
  expect(box().props.value).toBe(`see ${a} `);
  // the box holds the path as the browser shows it, with the caret after "@/tmp/"
  element.value = box().props.value as string;
  if (how === "paste") await paste(4 + "@/tmp/".length, "b"); else await pick(4 + "@/tmp/".length, "b");
  await finish("b");
  const b = `@${path("b")}`;
  expect(box().props.value).toBe(`see ${b} ${a} `);
  expect(badges()).toEqual(["ready", "ready"]);
  await act(async () => { button("Remove a.png").props.onClick(); });
  expect(box().props.value).toBe(`see ${b} `);
  expect(badges()).toEqual(["ready"]);
  await act(async () => { button("Remove b.png").props.onClick(); });
  expect(box().props.value).toBe("see ");
});

// Remove never glues the path beside it to a word: one space stays, and that file stays attached
it.each([
  ["two files picked together at the end of a word", async () => { await type("x", 1); await pick(1, "one", "two"); await finish("one"); await finish("two"); }],
  ["a second file pasted at the end of the first one's path", async () => {
    await type("x", 1);
    await paste(1, "one");
    await finish("one");
    element.value = box().props.value as string;
    await paste(1 + ` @${path("one")}`.length, "two");
    await finish("two");
  }],
] as const)("keeps the other path apart from the word before it when the first is removed: %s", async (_name, setUp) => {
  await open();
  await setUp();
  expect(box().props.value).toBe(`x @${path("one")} @${path("two")} `);
  await act(async () => { button("Remove one.png").props.onClick(); });
  expect(box().props.value).toBe(`x @${path("two")} `);
  expect(badges()).toEqual(["ready"]);
  expect(sendOff()).toBe(false);
});

// a finished upload whose draft another tab replaced with a lone /command is detached at once: Send is not held
it("detaches a finished upload at once when another tab replaced its draft with a lone /command, and holds no Send", async () => {
  await open();
  await type("hello", 5);
  await paste(5, "shot");
  await writeInOtherTab("/help");
  await finish("shot");
  expect(box().props.value).toBe("/help");
  expect(tiles()).toBe(0);
  expect(sendOff()).toBe(false);
  expect(announced()).toBe("shot.png detached from the message");
});

// the space before a path that another path went in front of is now that path's: Remove never takes it
it("keeps the front path apart from the next word when the path it went in front of is removed", async () => {
  await open();
  await type("see", 3);
  await paste(3, "a");
  await finish("a");
  const a = `@${path("a")}`;
  await type(`see ${a} more`);
  element.value = box().props.value as string;
  await paste(4 + "@/tmp/".length, "b");
  await finish("b");
  const b = `@${path("b")}`;
  expect(box().props.value).toBe(`see ${b} ${a} more`);
  await act(async () => { button("Remove a.png").props.onClick(); });
  expect(box().props.value).toBe(`see ${b} more`);
  expect(badges()).toEqual(["ready"]);
  expect(sendOff()).toBe(false);
});
