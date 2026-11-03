/**
 * Read aloud: one agent reply at a time is spoken by the server's Kokoro (shared/speech.ts). The reply loses what
 * a voice should not read (code, tables, links' addresses, markdown marks) and is cut into stretches that grow from
 * one sentence. The server makes a few stretches ahead while earlier ones play, and each is scheduled to start the
 * moment the one before ends, so speech starts after the first sentence and runs without breaks. Pausing freezes
 * the audio clock, and the last few replies keep their audio, so resuming or reading one again makes nothing twice.
 */
import { useSyncExternalStore } from "react";
import { SPEECH_MAX_CHARS, type SpeechVoice } from "../../shared/speech.ts";

/** The words a listener should hear: code blocks, tables, images and addresses go, link text and prose stay. */
export function speechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(\*\*|__|~~|\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, "")
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => /[\p{L}\p{N}]/u.test(block))
    .join("\n\n");
}

/** Stretches the server makes ahead of the one playing. It makes them one at a time, so more only wait in line. */
const AHEAD = 3;
/** The shortest stretch after the first, so a reply opening with "Sure." does not crawl along in tiny requests. */
const MIN_CHARS = 60;

/**
 * Stretches of whole sentences: the first is one sentence, so speech starts soon. Each one after may be at most
 * twice as long as the one before, up to `size` characters: the server speaks about twice as fast as it plays, so
 * the next is made before the last one ends. A sentence longer than a request is cut at a space.
 */
export function speechChunks(text: string, size = 300): string[] {
  const sentences = text.split(/\n{2,}/).flatMap((block) => block.match(/.+?(?:[.!?]+["')\]]*(?=\s|$)|$)\s*/g) ?? [])
    .map((sentence) => sentence.trim()).filter(Boolean)
    .flatMap((sentence) => {
      const parts: string[] = [];
      let rest = sentence;
      while (rest.length > SPEECH_MAX_CHARS) {
        const cut = rest.lastIndexOf(" ", SPEECH_MAX_CHARS);
        const at = cut > 0 ? cut : SPEECH_MAX_CHARS;
        parts.push(rest.slice(0, at));
        rest = rest.slice(at).trim();
      }
      return [...parts, rest];
    });
  const chunks: string[] = [];
  let limit = 0;
  for (const sentence of sentences) {
    const last = chunks.length > 1 ? chunks[chunks.length - 1]! : null;
    if (last !== null && last.length + sentence.length + 1 <= limit) {
      chunks[chunks.length - 1] = `${last} ${sentence}`;
      continue;
    }
    if (chunks.length > 0) limit = Math.min(size, Math.max(MIN_CHARS, 2 * chunks[chunks.length - 1]!.length));
    chunks.push(sentence);
  }
  return chunks;
}

export type SpeechStatus = "idle" | "loading" | "playing" | "paused" | "failed";
interface Playback { id: string; status: SpeechStatus }

/** Replies whose audio is kept, newest last; a long one is a few MB. */
const KEPT = 4;
const kept = new Map<string, { text: string; buffers: AudioBuffer[] }>();

function keptAudio(id: string, voice: SpeechVoice, text: string): AudioBuffer[] {
  const key = `${voice}:${id}`;
  let entry = kept.get(key);
  if (entry?.text !== text) entry = { text, buffers: [] };
  kept.delete(key);
  kept.set(key, entry);
  for (const old of kept.keys()) {
    if (kept.size <= KEPT) break;
    kept.delete(old);
  }
  return entry.buffers;
}

let playback: Playback = { id: "", status: "idle" };
let session = 0;
let context: AudioContext | null = null;
const sources = new Set<AudioBufferSourceNode>();
let abort: AbortController | null = null;
const listeners = new Set<() => void>();

function set(next: Playback): void {
  playback = next;
  for (const listener of listeners) listener();
}

/** Where `id` stands: only the reply being read is ever loading, playing or paused. */
export function useSpeechStatus(id: string): SpeechStatus {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => (playback.id === id ? playback.status : "idle"),
    () => "idle",
  );
}

/** A running context holds the phone's audio output (and a wakelock) open, so it is let go while nothing is read. `speak` resumes it from the tap. */
function rest(): void {
  void context?.suspend().catch(() => undefined);
}

export function stopSpeech(): void {
  halt();
  rest();
}

function halt(): void {
  session += 1;
  abort?.abort();
  abort = null;
  for (const node of sources) {
    try { node.stop(); } catch { /* it had not started */ }
  }
  sources.clear();
  if (playback.status !== "idle") set({ id: "", status: "idle" });
}

/** Pauses or resumes the reply being read. Call it from the tap itself, as iOS resumes audio only on a gesture. */
export function toggleSpeechPause(): void {
  if (!context || (playback.status !== "playing" && playback.status !== "paused")) return;
  const pausing = playback.status === "playing";
  void (pausing ? context.suspend() : context.resume());
  set({ id: playback.id, status: pausing ? "paused" : "playing" });
}

async function fetchChunk(text: string, voice: SpeechVoice, signal: AbortSignal): Promise<AudioBuffer> {
  const response = await fetch("/api/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }), credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`speech ${response.status}`);
  return context!.decodeAudioData(await response.arrayBuffer());
}

/** Starts `buffer` at `at` on the audio clock; the promise settles when it has played. */
function schedule(buffer: AudioBuffer, at: number): Promise<void> {
  return new Promise((resolve) => {
    const node = context!.createBufferSource();
    node.buffer = buffer;
    node.connect(context!.destination);
    node.onended = () => { sources.delete(node); resolve(); };
    sources.add(node);
    node.start(at);
  });
}

/**
 * Reads `markdown` aloud as reply `id`, stopping whatever was being read. Call it from the tap itself: iOS lets
 * only a user gesture start audio, so the AudioContext is made and resumed before anything is awaited.
 */
export function speak(id: string, markdown: string, voice: SpeechVoice): void {
  halt();
  const text = speechText(markdown);
  const chunks = speechChunks(text);
  if (chunks.length === 0 || typeof AudioContext === "undefined") return;
  const buffers = keptAudio(id, voice, text);
  context ??= new AudioContext();
  void context.resume();
  const mine = ++session;
  const controller = abort = new AbortController();
  set({ id, status: "loading" });
  void (async () => {
    const pending: Promise<AudioBuffer>[] = [];
    const ask = (index: number) => {
      if (index >= chunks.length) return;
      const ready = buffers[index];
      const chunk = ready ? Promise.resolve(ready) : fetchChunk(chunks[index]!, voice, controller.signal);
      chunk.then((buffer) => { buffers[index] = buffer; }, () => {}); // a failure surfaces when its turn is awaited
      pending[index] = chunk;
    };
    try {
      for (let index = 0; index <= AHEAD; index++) ask(index);
      let end = 0;
      let played: Promise<void> = Promise.resolve();
      for (let index = 0; index < chunks.length; index++) {
        const buffer = await pending[index]!;
        if (mine !== session) return;
        ask(index + AHEAD + 1);
        const at = Math.max(context!.currentTime, end);
        end = at + buffer.duration;
        played = schedule(buffer, at);
        if (playback.status === "loading") set({ id, status: "playing" });
      }
      await played;
      if (mine === session) { set({ id: "", status: "idle" }); rest(); }
    } catch {
      if (mine === session) { set({ id, status: "failed" }); rest(); }
    }
  })();
}
