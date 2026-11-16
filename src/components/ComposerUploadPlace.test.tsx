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
type Box = { value: string; selectionStart: number; selectionEnd: number; selectionDirection: "none"; focused: number; style: Record<string, string>; focus(): void; setSelectionRange(start: number, end: number): void };
let element: Box;
const uploads = new Map<string, { resolve: (path: string) => void; reject: (error: unknown) => void }>();
const path = (name: string) => `/tmp/proj/.ovis/${name}-20261116-101010-0123abcd.png`;

async function open(): Promise<void> {
  const props: ComposerProps = {
    paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: () => true, onAbort() {},
    onUploadImage: (file) => new Promise<string>((resolve, reject) => { uploads.set(file.name.replace(/\.png$/u, ""), { resolve, reject }); }),
  };
  element = { value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none", focused: 0, style: {}, focus() { this.focused++; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const measure = { style: {}, scrollHeight: 0 };
  await act(async () => {
    renderer = create(<Composer {...props} />, { createNodeMock: (node) => node.type !== "textarea" ? null : (node.props as { onKeyDown?: unknown }).onKeyDown ? element : measure });
  });
}
const box = () => renderer!.root.findAll((node) => node.type === "textarea" && node.props.onKeyDown !== undefined)[0]!;
const png = (name: string) => new File([new Uint8Array([1])], `${name}.png`, { type: "image/png" });
/** the user's edit: the box's value and caret, then its change event */
async function type(value: string, caret = value.length): Promise<void> {
  Object.assign(element, { value, selectionStart: caret, selectionEnd: caret });
  await act(async () => { box().props.onChange({ target: element }); });
}
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
  await act(async () => { box().props.onCompositionStart(); });
  await type("before ㅎafter", 8);
  await type("before 하after", 8);
  await finish("shot");
  await type("before 한after", 8);
  expect(box().props.value).toBe("before 한after");
  await act(async () => {
    box().props.onCompositionEnd();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(box().props.value).toBe(`before @${path("shot")} 한after`);
});

it("never puts the path of an upload started in a cleared draft into the new one", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  expect(tiles()).toBe(1);
  await type("");
  await type("new draft");
  await finish("shot");
  expect(box().props.value).toBe("new draft");
  expect(tiles()).toBe(0);
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
