import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

const pane = "swipe-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["requestAnimationFrame", "cancelAnimationFrame"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: Page;

beforeEach(() => {
  page = openPage("https://ovis.test/");
  for (const [key, value] of Object.entries({ ResizeObserver: page.window.ResizeObserver, HTMLElement: page.window.HTMLElement, Event: page.window.Event, CustomEvent: page.window.CustomEvent })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const values: Record<string, unknown> = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} };
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

afterEach(async () => {
  await page.close();
  composerDrafts.set(draftKey, "", "replace");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

type Point = [x: number, y: number, msSinceDown?: number];

function touch(field: Element, type: string, [x, y, at = 0]: Point): void {
  const point = new page.window.Touch({ identifier: 1, target: field as never, clientX: x, clientY: y });
  const event = new page.window.TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [point], changedTouches: [point] });
  // React reads a zero timeStamp as missing and uses the clock instead
  Object.defineProperty(event, "timeStamp", { value: 1000 + at });
  field.dispatchEvent(event as never);
}

async function swipe(draft: string, suggestion: string | null, path: Point[], over: Partial<ComposerProps> = {}): Promise<string> {
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, suggestion, onSend: () => true, onAbort() {}, onUploadImage: async () => "", ...over };
  composerDrafts.set(draftKey, draft, "replace");
  await page.render(<Composer {...props} />);
  const box = page.one("textarea.composer-text");
  const [first, ...rest] = path;
  await act(async () => { touch(box, "touchstart", first!); });
  for (const point of rest) await act(async () => { touch(box, "touchmove", point); });
  return composerDrafts.read(draftKey).text;
}

it("a forward swipe across the empty box takes the suggestion", async () => {
  expect(await swipe("", "run the tests", [[100, 300], [200, 305]])).toBe("run the tests");
});

it("a right-to-left box takes a swipe to the left", async () => {
  page.container.style.direction = "rtl";
  expect(await swipe("", "run the tests", [[200, 300], [100, 300]])).toBe("run the tests");
});

it("leaves the box alone for a backward swipe, a vertical drag, an edge start or typed text", async () => {
  expect(await swipe("", "run the tests", [[200, 300], [100, 300]])).toBe("");
  expect(await swipe("", "run the tests", [[100, 300], [130, 420]])).toBe("");
  expect(await swipe("", "run the tests", [[10, 300], [200, 300]])).toBe("");
  expect(await swipe("typed", "run the tests", [[100, 300], [200, 300]])).toBe("typed");
});

it("a stroke that began as a scroll stays one when it turns sideways", async () => {
  expect(await swipe("", "run the tests", [[100, 300], [103, 330], [200, 332]])).toBe("");
});

it("a long press that then slides is the caret or a selection, not a swipe", async () => {
  expect(await swipe("", "run the tests", [[100, 300, 0], [102, 301, 300], [200, 302, 800]])).toBe("");
  // a quick start that slows down is still a swipe
  expect(await swipe("", "run the tests", [[100, 300, 0], [120, 301, 60], [200, 302, 900]])).toBe("run the tests");
});

it("does nothing while text is selected or in a pane that may only be watched", async () => {
  const selection = spyOn(page.window.document, "getSelection").mockReturnValue({ isCollapsed: false } as never);
  expect(await swipe("", "run the tests", [[100, 300], [200, 305]])).toBe("");
  selection.mockRestore();
  expect(await swipe("", "run the tests", [[100, 300], [200, 305]], { role: "observe" })).toBe("");
});

it("a stroke that turns down after starting sideways is a scroll", async () => {
  expect(await swipe("", "run the tests", [[100, 300], [140, 300], [140, 322], [150, 322]])).toBe("");
});

it("a second finger elsewhere, even one already lifted, ends the swipe", async () => {
  await swipe("", "run the tests", [[100, 300], [130, 300]]);
  const box = page.one("textarea.composer-text"), transcript = page.container.ownerDocument.body;
  await act(async () => {
    touch(transcript, "touchstart", [300, 100]);
    touch(transcript, "touchend", [300, 100]);
    touch(box, "touchmove", [190, 300]);
  });
  expect(composerDrafts.read(draftKey).text).toBe("");
});

it("takes the suggestion when the finger lifts past the threshold", async () => {
  await swipe("", "run the tests", [[100, 300], [145, 300]]);
  await act(async () => { touch(page.one("textarea.composer-text"), "touchend", [152, 300]); });
  expect(composerDrafts.read(draftKey).text).toBe("run the tests");
});
