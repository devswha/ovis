import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import type { VoiceEngine, VoiceInput } from "../lib/voice.ts";
import { MicButton, type Dictation } from "./VoiceInput.tsx";

describe("MicButton", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
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

  async function mic(engine: VoiceEngine) {
    const voice = {
      available: true, unavailableReason: null, engine, state: "idle", elapsedMs: 0, silent: false, error: null,
      press: () => {}, release: () => calls.push("release"), finish: () => {}, cancel: () => {},
      bindBars: () => {}, bindRing: () => {}, bindMeter: () => {},
    } satisfies VoiceInput;
    const dictation: Dictation = { shown: true, connected: true, voice, forget: () => {}, partial: "", press: () => calls.push("press") };
    await act(async () => { renderer = create(<SettingsProvider><MicButton dictation={dictation} /></SettingsProvider>); });
    const button = renderer!.root.findByType("button");
    const pointer = (pointerType: string) => ({ button: 0, pointerType, pointerId: 1, preventDefault: () => {}, currentTarget: { setPointerCapture: () => {} } });
    return {
      down: (pointerType: string) => act(() => { button.props.onPointerDown(pointer(pointerType)); }),
      up: (pointerType: string) => act(() => { button.props.onPointerUp(pointer(pointerType)); }),
      click: () => act(() => { button.props.onClick({ detail: 1 }); }),
    };
  }

  // iOS WebKit lets SpeechRecognition.start() run only from a user activation, and a touch's
  // pointerdown is none: a take started there ends in "not-allowed" (#2343)
  it("starts the browser engine from a touch tap's click, not its pointerdown", async () => {
    const button = await mic("browser");
    await button.down("touch");
    expect(calls).toEqual([]);
    await button.up("touch");
    await button.click();
    expect(calls).toEqual(["press"]);
  });

  it("keeps press-on-pointerdown and release for a mouse, and for the server engine on touch", async () => {
    const mouse = await mic("browser");
    await mouse.down("mouse");
    await mouse.up("mouse");
    await mouse.click();
    expect(calls).toEqual(["press", "release"]);
    await act(async () => { renderer?.unmount(); });
    calls = [];
    const server = await mic("server");
    await server.down("touch");
    await server.up("touch");
    await server.click();
    expect(calls).toEqual(["press", "release"]);
  });
});
