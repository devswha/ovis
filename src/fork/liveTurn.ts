/**
 * The message pi is writing (conversation-live, from pi's ovis-model extension), drawn as part of
 * the chat until the transcript holds it. Its turn's `ts` is when the message began and the line
 * pi writes for the finished message is stamped later, so a last turn ending at or after it holds
 * the message itself.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { paceGrew, paceStep, REVEAL_TICK_MS, stablePrefix, startPace, wordCut, type Pace } from "./streamReveal.ts";

/** a live message whose file is gone stays this long at most while the transcript is read */
export const LIVE_HOLD_MS = 5000;

export function liveLanded(turns: readonly ConversationTurn[], live: ConversationTurn): boolean {
  const last = turns.at(-1);
  const began = Date.parse(live.ts ?? "");
  const ended = Date.parse(last?.end_ts ?? last?.ts ?? "");
  return Number.isFinite(began) && Number.isFinite(ended) && ended >= began;
}

/** The turns with the live message's parts after them: on the last turn when it is the agent's, else a turn of its own. */
export function withLiveTurn(turns: ConversationTurn[], live: ConversationTurn | null): ConversationTurn[] {
  if (live === null || live.parts.length === 0 || liveLanded(turns, live)) return turns;
  const last = turns.at(-1);
  if (last?.role !== "assistant") return [...turns, live];
  return [...turns.slice(0, -1), { ...last, end_ts: live.ts ?? last.end_ts, parts: [...last.parts, ...live.parts] }];
}

/** the chat was opened or shown again this recently: a reply under way is drawn as far as it got */
const OPEN_GRACE_MS = 1500;

type Streamed = Extract<ConversationPart, { kind: "text" | "thinking" }>;

/** The part a reply streams into: the last turn's last text (or thinking, where it shows) part, while that turn is the agent's. */
function streamedPart(turns: readonly ConversationTurn[], showThinking: boolean): { index: number; part: Streamed } | null {
  const last = turns.at(-1);
  const part = last?.parts.at(-1);
  if (last?.role !== "assistant" || part === undefined || !(part.kind === "text" || (showThinking && part.kind === "thinking"))) return null;
  return { index: last.parts.length - 1, part };
}

interface Reveal {
  /** the live message (its start) and the part of it being revealed */
  readonly key: string;
  /** the part's text, and whether its message is done (no live file any more) */
  readonly full: string;
  readonly done: boolean;
  /** how much of it is drawn: the part must still start with it */
  readonly drawn: number;
  readonly pace: Pace;
}

function drawnLength(reveal: Pick<Reveal, "full" | "done" | "pace">): number {
  return stablePrefix(reveal.full, wordCut(reveal.full, reveal.pace.shown, reveal.done), reveal.done);
}

/**
 * The turns with a streaming reply revealed at an even pace (lib/streamReveal.ts): its part is cut
 * to the words reached so far, short of any markdown still open. A part first seen while it
 * streams is revealed from its start; one under way when the chat was opened or shown again is
 * drawn as it stands and revealed from there. The reveal goes on once the message is done and
 * the transcript holds it, so the finished reply does not land all at once. Its steps run only
 * while the chat is visible, at most every REVEAL_TICK_MS, and only when a step reaches a word.
 */
export function useRevealedTurns(turns: ConversationTurn[], live: ConversationTurn | null, visible: boolean, showThinking: boolean): { turns: ConversationTurn[]; revealing: boolean } {
  const [mounted] = useState(() => Date.now());
  const shownSince = useRef(mounted);
  const liveAt = useRef<string | null>(null);
  const reveal = useRef<Reveal | null>(null);
  const [, setStep] = useState(0);
  if (live?.ts !== undefined) liveAt.current = live.ts;
  const streamed = streamedPart(turns, showThinking);
  const key = streamed === null || liveAt.current === null ? null : `${liveAt.current}:${streamed.index}`;
  const done = live === null;
  const now = Date.now();
  let current = reveal.current;
  if (key === null || streamed === null) current = null;
  else if (current?.key !== key || !streamed.part.text.startsWith(current.full.slice(0, current.drawn))) {
    const text = streamed.part.text;
    const underWay = !visible || now - shownSince.current < OPEN_GRACE_MS;
    current = done ? null : { key, full: text, done, drawn: 0, pace: startPace(text.length, underWay ? text.length : 0, now) };
  } else current = { ...current, full: streamed.part.text, done, pace: paceGrew(current.pace, streamed.part.text.length, now) };
  if (current !== null) current = { ...current, drawn: drawnLength(current) };
  reveal.current = current;
  const revealing = current !== null && current.drawn < current.full.length;

  useEffect(() => {
    if (visible) shownSince.current = Date.now();
    else if (reveal.current !== null) reveal.current = { ...reveal.current, pace: { ...reveal.current.pace, shown: reveal.current.pace.length } };
  }, [visible]);
  const stepping = revealing && visible;
  useEffect(() => {
    if (!stepping) return;
    const timer = setInterval(() => {
      const before = reveal.current;
      if (before === null) return;
      const next = { ...before, pace: paceStep(before.pace, Date.now()) };
      reveal.current = next;
      if (drawnLength(next) !== before.drawn) setStep((step) => step + 1);
    }, REVEAL_TICK_MS);
    return () => clearInterval(timer);
  }, [stepping]);

  if (!revealing || current === null) return { turns, revealing };
  const last = turns.at(-1)!;
  const kept = last.parts.slice(0, -1);
  const part = { ...(last.parts.at(-1) as Streamed), text: current.full.slice(0, current.drawn) };
  return { turns: [...turns.slice(0, -1), { ...last, parts: current.drawn === 0 ? kept : [...kept, part] }], revealing };
}

/** the steps a new word's fade takes, one a reveal tick: about a quarter of a second */
const FADE_STEPS = 4;
const fades: Highlight[] = [];

/** The highlight drawing a word `step` ticks into its fade, `::highlight(live-fade-N)`; null where there is no Highlight API. */
function fadeHighlight(step: number): Highlight | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return null;
  let highlight = fades[step];
  if (highlight === undefined) {
    highlight = new Highlight();
    fades[step] = highlight;
    CSS.highlights.set(`live-fade-${step + 1}`, highlight);
  }
  return highlight;
}

/** A range over an element's text between two character offsets. */
function textRange(element: HTMLElement, from: number, to: number): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && seen + length > from) { range.setStart(node, from - seen); started = true; }
    if (started && seen + length >= to) { range.setEnd(node, to - seen); return range; }
    seen += length;
  }
  return null;
}

/**
 * While a reply streams, each word it adds fades in: drawn through FADE_STEPS highlights from
 * faint to full, a step every REVEAL_TICK_MS. The highlights are paint over text already laid
 * out, so no step lays the chat out again; none is drawn for a reader who prefers reduced motion.
 * What the turn held when it was first seen does not fade.
 */
export function useFadeIn(article: RefObject<HTMLElement | null>, streaming: boolean, turn: ConversationTurn): void {
  const last = useRef<{ element: HTMLElement; length: number } | null>(null);
  const steps = useRef<{ from: number; at: number }[]>([]);
  const drawn = useRef<{ highlight: Highlight; range: Range }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const paint = useCallback(function paint(): void {
    clearTimeout(timer.current);
    for (const { highlight, range } of drawn.current) highlight.delete(range);
    drawn.current = [];
    const now = performance.now();
    const element = last.current?.element;
    const length = last.current?.length ?? 0;
    steps.current = steps.current.filter((step) => now - step.at < FADE_STEPS * REVEAL_TICK_MS && step.from < length);
    if (element === undefined || steps.current.length === 0) return;
    steps.current.forEach((step, index) => {
      const highlight = fadeHighlight(Math.min(FADE_STEPS - 1, Math.floor((now - step.at) / REVEAL_TICK_MS)));
      const range = highlight === null ? null : textRange(element, step.from, steps.current[index + 1]?.from ?? length);
      if (highlight === null || range === null) return;
      highlight.add(range);
      drawn.current.push({ highlight, range });
    });
    timer.current = setTimeout(paint, REVEAL_TICK_MS);
  }, []);
  useLayoutEffect(() => {
    const blocks = article.current?.querySelectorAll<HTMLElement>(".markdown");
    const element = blocks?.[blocks.length - 1] ?? null;
    const length = element?.textContent?.length ?? 0;
    const before = last.current;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    last.current = streaming && !still && element !== null ? { element, length } : null;
    if (before === null || last.current === null || before.element !== element) steps.current = [];
    if (before !== null && last.current !== null) {
      const from = before.element === element ? before.length : 0;
      if (length > from) steps.current.push({ from, at: performance.now() });
    }
    paint();
  }, [article, streaming, turn, paint]);
  useEffect(() => () => {
    clearTimeout(timer.current);
    for (const { highlight, range } of drawn.current) highlight.delete(range);
  }, []);
}

/** The last live message, kept a while after its file goes: the transcript may not hold it yet. */
export function useHeldLive(live: ConversationTurn | null): ConversationTurn | null {
  const [held, setHeld] = useState(live);
  useEffect(() => {
    if (live !== null) { setHeld(live); return; }
    const timer = setTimeout(() => setHeld(null), LIVE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [live]);
  return live ?? held;
}
