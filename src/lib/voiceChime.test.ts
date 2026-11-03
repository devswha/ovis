import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { playVoiceChime, primeVoiceChime } from "./voiceChime.ts";

type Source = { buffer: unknown; onended: (() => void) | null; connect(): void; start(): void };

let suspends = 0;
let sources: Source[] = [];
class FakeAudioContext {
  destination = {};
  async resume() {}
  async suspend() { suspends += 1; }
  createBuffer() { return { copyToChannel() {} }; }
  createBufferSource(): Source {
    const source: Source = { buffer: null, onended: null, connect() {}, start() {} };
    sources.push(source);
    return source;
  }
}

const saved = new Map<string, unknown>();
function stub(name: string, value: unknown): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (!saved.has(name)) saved.set(name, scope[name]);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

let visibility: "visible" | "hidden" = "visible";
let onVisibility: (() => void) | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  suspends = 0;
  sources = [];
  stub("window", { AudioContext: FakeAudioContext });
  stub("document", {
    get visibilityState() { return visibility; },
    addEventListener: (_type: string, listener: () => void) => { onVisibility ??= listener; },
  });
});
afterEach(() => {
  for (const [name, value] of saved) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  saved.clear();
});

describe("voice chime audio", () => {
  it("lets the audio output go when a chime ends with the page out of sight", async () => {
    primeVoiceChime();
    visibility = "hidden";
    playVoiceChime("open");
    await settle();
    expect(suspends).toBe(0);
    sources[0]!.onended!();
    expect(suspends).toBe(1);
  });

  it("keeps it while the page is shown, and while a chime still plays", async () => {
    visibility = "visible";
    playVoiceChime("close");
    playVoiceChime("open");
    await settle();
    sources[0]!.onended!();
    expect(suspends).toBe(0);
    visibility = "hidden";
    onVisibility!();
    expect(suspends).toBe(0);
    sources[1]!.onended!();
    expect(suspends).toBe(1);
  });

  it("lets it go when the page is hidden with nothing playing", async () => {
    visibility = "visible";
    playVoiceChime("close");
    await settle();
    sources[0]!.onended!();
    visibility = "hidden";
    onVisibility!();
    expect(suspends).toBe(1);
  });
});
