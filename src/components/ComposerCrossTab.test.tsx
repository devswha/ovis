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

// #2369: two tabs on one pane send its draft once, whoever presses Send first
const pane = "cross-tab-pane", draftKey = `ovis:composer-draft:${pane}`, lockName = `ovis-send:${draftKey}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
/** the storage every tab of the origin shares */
let data: Map<string, string>;

/** Web Locks as the browser grants them: one holder per name, the others queued in order. */
function locks(): { request(name: string, run: () => unknown): Promise<unknown> } {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name, run) {
      const next = (tails.get(name) ?? Promise.resolve()).then(run);
      tails.set(name, next.catch(() => undefined));
      return next;
    },
  };
}

function setGlobals(lockManager?: ReturnType<typeof locks>): void {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0, ...(lockManager ? { locks: lockManager } : {}) },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
}

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  setGlobals();
  data = new Map<string, string>();
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

/** This tab's composer with `draft` in its box: the messages it sends, and its Send button. */
async function tabWith(draft: string, onSend: (message: string) => ReturnType<ComposerProps["onSend"]> = () => true): Promise<{ sent: string[]; press: () => Promise<void> }> {
  const sent: string[] = [];
  composerDrafts.set(draftKey, draft);
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: (message) => { sent.push(message); return onSend(message); }, onAbort() {}, onUploadImage: async () => "" };
  await act(async () => { renderer = create(<Composer {...props} />); });
  return { sent, press: () => act(async () => { renderer!.root.findByProps({ "aria-label": "Send message" }).props.onClick(); }) };
}

it("does not send a draft another tab sent while it held the pane's send lock", async () => {
  const lockManager = locks();
  setGlobals(lockManager);
  const tab = await tabWith("deploy");
  // the other tab pressed first: it holds the lock while it claims the draft
  let release = (): void => {};
  const other = lockManager.request(lockName, () => new Promise<void>((resolve) => { release = resolve; }));
  await tab.press();
  expect(tab.sent).toEqual([]);
  // its send is acknowledged and settles the draft; no storage event has reached this tab yet
  data.delete(draftKey);
  await act(async () => { release(); await other; });
  expect(tab.sent).toEqual([]);
});

it("does not send a draft another tab sent before this one heard of it, without Web Locks either", async () => {
  const tab = await tabWith("deploy");
  data.delete(draftKey);
  await tab.press();
  expect(tab.sent).toEqual([]);
});

it("settles an acknowledged send only once the pane's send lock is free", async () => {
  const lockManager = locks();
  setGlobals(lockManager);
  let acknowledge = (_ok: boolean): void => {};
  const tab = await tabWith("deploy", () => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
  await tab.press();
  expect(tab.sent).toEqual(["deploy"]);
  // another tab claims the pane while the acknowledgement arrives: the draft is read as it was until it is done
  let release = (): void => {};
  const other = lockManager.request(lockName, () => new Promise<void>((resolve) => { release = resolve; }));
  await act(async () => { acknowledge(true); });
  expect(data.get(draftKey)).toBe("deploy");
  await act(async () => { release(); await other; });
  expect(data.has(draftKey)).toBe(false);
  expect(composerDrafts.read(draftKey).sending).toBe(false);
});

it("sends a draft no other tab sent, once (control)", async () => {
  setGlobals(locks());
  const tab = await tabWith("deploy");
  await tab.press();
  await tab.press();
  expect(tab.sent).toEqual(["deploy"]);
});
