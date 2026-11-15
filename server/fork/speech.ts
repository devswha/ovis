/**
 * Read aloud (shared/speech.ts): Kokoro-82M turns a stretch of an agent's reply into WAV on this machine, free and
 * offline. Nothing is installed or loaded until the first request: kokoro-js (about 400 MB with ONNX Runtime) goes
 * into the state directory then, and its model (about 330 MB) beside it, so a server nobody listens to never pays
 * for either. The model leaves memory after a quiet spell and requests take turns, sparing a small machine's CPU.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPEECH_MAX_CHARS, SPEECH_VOICES, type SpeechVoice } from "../../shared/speech.ts";
import { errorResponse, isJsonObject, jsonResponse, setRequestRoute } from "../http.ts";

const KOKORO_VERSION = "1.2.1";
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
// fp32 speaks about half again as fast as q8 on a CPU, for 300 MB more memory while loaded
const DTYPE = "fp32";
const SPEED = 1.15;
const IDLE_MS = 10 * 60_000;

/** What reading aloud needs from Kokoro; tests pass their own. */
export interface SpeechEngine {
  wav(text: string, voice: SpeechVoice): Promise<ArrayBuffer>;
  dispose(): Promise<void>;
}

interface KokoroModule {
  KokoroTTS: { from_pretrained(model: string, options: { dtype: string; device: string }): Promise<{
    generate(text: string, options: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
    model: { dispose(): Promise<unknown> };
  }> };
}

/** 16-bit PCM WAV, which every browser decodes; Kokoro's own toWav() writes 32-bit float, twice the bytes. */
export function pcmWav(samples: Float32Array, rate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff, true);
  return view.buffer;
}

/** Installs kokoro-js under `dir` on first use (with the bun running this server), then loads the model. */
async function loadKokoro(dir: string): Promise<SpeechEngine> {
  const entry = join(dir, "node_modules/kokoro-js/dist/kokoro.js");
  if (!existsSync(entry)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, dependencies: { "kokoro-js": KOKORO_VERSION } }));
    const install = Bun.spawn([process.execPath, "install", "--production"], { cwd: dir, stdout: "ignore", stderr: "pipe" });
    if (await install.exited !== 0) throw new Error(`installing kokoro-js failed: ${(await new Response(install.stderr).text()).trim().slice(-300)}`);
  }
  const { KokoroTTS } = await import(entry) as KokoroModule;
  const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: DTYPE, device: "cpu" });
  return {
    wav: async (text, voice) => { const { audio, sampling_rate } = await tts.generate(text, { voice, speed: SPEED }); return pcmWav(audio, sampling_rate); },
    dispose: async () => { await tts.model.dispose(); },
  };
}

export interface SpeechServiceOptions {
  stateDir: string;
  load?: () => Promise<SpeechEngine>;
}

export class SpeechService {
  private readonly load: () => Promise<SpeechEngine>;
  private engine: Promise<SpeechEngine> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SpeechServiceOptions) {
    this.load = options.load ?? (() => loadKokoro(join(options.stateDir, "speech")));
  }

  /** One stretch at a time: a second phone, or the next stretch, waits for the one being made. */
  speak(text: string, voice: SpeechVoice, signal?: AbortSignal): Promise<ArrayBuffer> {
    const turn = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (this.idle) clearTimeout(this.idle);
      // a failed load is forgotten, so the next tap tries again
      const engine = this.engine ??= this.load().catch((error: unknown) => { this.engine = null; throw error; });
      try { return await (await engine).wav(text, voice); }
      finally { this.idle = setTimeout(() => void this.unload(), IDLE_MS); this.idle.unref?.(); }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async unload(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    await (await engine?.catch(() => null))?.dispose();
  }
}

export async function handleSpeechRequest(request: Request, service: SpeechService): Promise<Response> {
  setRequestRoute("/api/speech");
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use POST /api/speech" } }, 405, { allow: "POST" });
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const text = isJsonObject(body) && typeof body["text"] === "string" ? body["text"].trim() : "";
  const voice = isJsonObject(body) ? body["voice"] : undefined;
  if (!text || text.length > SPEECH_MAX_CHARS || !SPEECH_VOICES.includes(voice as SpeechVoice)) {
    return jsonResponse({ error: { code: "invalid_request", message: `Send { text, voice }: text of 1-${SPEECH_MAX_CHARS} characters and a known voice` } }, 400);
  }
  try {
    const wav = await service.speak(text, voice as SpeechVoice, request.signal);
    return new Response(wav, { status: 200, headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
