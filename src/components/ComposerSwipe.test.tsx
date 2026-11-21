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

const pane = "swipe-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let direction = "ltr";

beforeEach(() => {
  direction = "ltr";
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 5 },
    window: { ...listen, innerWidth: 400, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: true, ...listen }), setTimeout, clearTimeout, getComputedStyle: () => ({ direction }) },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
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

const touch = (x: number, y: number) => ({ clientX: x, clientY: y });
const event = (...points: { clientX: number; clientY: number }[]) => ({ touches: points, currentTarget: {} });

async function swipe(draft: string, suggestion: string | null, from: [number, number], to: [number, number]): Promise<string> {
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, suggestion, onSend: () => true, onAbort() {}, onUploadImage: async () => "" };
  await act(async () => { renderer?.unmount(); });
  composerDrafts.set(draftKey, draft);
  await act(async () => { renderer = create(<Composer {...props} />); });
  const box = renderer!.root.findAll((node) => node.type === "textarea" && node.props.onTouchStart !== undefined)[0]!;
  await act(async () => { box.props.onTouchStart(event(touch(...from))); });
  await act(async () => { box.props.onTouchMove(event(touch(...to))); });
  return composerDrafts.read(draftKey).text;
}

it("a forward swipe across the empty box takes the suggestion", async () => {
  expect(await swipe("", "run the tests", [100, 300], [200, 305])).toBe("run the tests");
});

it("a right-to-left box takes a swipe to the left", async () => {
  direction = "rtl";
  expect(await swipe("", "run the tests", [200, 300], [100, 300])).toBe("run the tests");
});

it("leaves the box alone for a backward swipe, a vertical drag, an edge start or typed text", async () => {
  expect(await swipe("", "run the tests", [200, 300], [100, 300])).toBe("");
  expect(await swipe("", "run the tests", [100, 300], [130, 420])).toBe("");
  expect(await swipe("", "run the tests", [10, 300], [200, 300])).toBe("");
  expect(await swipe("typed", "run the tests", [100, 300], [200, 300])).toBe("typed");
});

it("shows the arrow only over an empty box with a suggestion, and a tap on it takes the suggestion", async () => {
  const arrows = () => renderer!.root.findAll((node) => node.type === "button" && node.props.className === "composer-swipe-hint");
  // a backward stroke leaves the empty box as it was, so the arrow is still there to tap
  expect(await swipe("", "run the tests", [200, 300], [100, 300])).toBe("");
  expect(arrows().map((arrow) => arrow.props["aria-label"])).toEqual(["Swipe or tap to use the suggestion"]);
  await act(async () => { arrows()[0]!.props.onClick(); });
  expect(composerDrafts.read(draftKey).text).toBe("run the tests");
  expect(arrows()).toHaveLength(0);
  await swipe("", null, [200, 300], [100, 300]);
  expect(arrows()).toHaveLength(0);
});
