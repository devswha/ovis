/**
 * Animated replies: each new word of the chat's last reply fades in, the way Streamdown
 * (github.com/vercel/streamdown, Apache-2.0) animates a stream. A word is drawn as soon as it
 * arrives, in a span of its own whose CSS animation the browser runs (`[data-fork-fade]` in
 * chat.css), so its room on the line is taken at once and nothing is drawn again while it fades.
 * The words an update brings are staggered STAGGER_MS apart, closer when that would put the last
 * one more than MAX_BACKLOG_MS out, so a burst reads as evenly as a trickle. A word keeps the
 * delay it was given, so a later update never replays or cuts short its fade.
 */
import { createElement, useMemo, useRef, useState, type ReactNode } from "react";

import type { ConversationTurn } from "../../../shared/protocol.ts";

/** words 100ms apart, an update's words all started within 1000ms (Streamdown: 40 and 320); the fade's 350ms is in chat.css */
const STAGGER_MS = 100;
const MAX_BACKLOG_MS = 1000;
const MIN_STEP_MS = 4;
/** the chat was opened or shown again this recently: the reply is drawn as it stands */
export const OPEN_GRACE_MS = 1500;

const SPACE = /\s/;
const ONLY_SPACE = /^\s+$/;
/** CJK has no spaces between words: each of its characters is a word */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/** `text` cut into words, each with the space after it (Streamdown's word split). */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inSpace = false;
  let cjk = false;
  for (const char of text) {
    const space = SPACE.test(char);
    const isCjk = !space && CJK.test(char);
    if (!space && word !== "" && (isCjk || cjk)) { words.push(word); word = ""; inSpace = false; }
    else if (space !== inSpace && word !== "") {
      if (space) { word += char; inSpace = true; continue; }
      words.push(word);
      word = "";
    }
    word += char;
    inSpace = space;
    cjk = isCjk;
  }
  if (word !== "") words.push(word);
  return words;
}

/** How many words a turn's text and thinking hold. */
export function turnWords(turn: ConversationTurn | undefined): number {
  let count = 0;
  for (const part of turn?.parts ?? []) {
    if (part.kind === "text" || part.kind === "thinking") count += splitWords(part.text).filter((word) => !ONLY_SPACE.test(word)).length;
  }
  return count;
}

export interface Pass {
  /** the first new word's delay and the time between new words */
  readonly base: number;
  readonly step: number;
  /** how many new words the pass may start */
  readonly count: number;
}

/**
 * The delays for `count` new words at `now`: they start where the last update's words stopped
 * (no earlier than now, no later than MAX_BACKLOG_MS out) and STAGGER_MS apart, closer when the
 * last would start past MAX_BACKLOG_MS. Streamdown's timeline `take`. `cursor` is when the last
 * update's words were all started; the new one is returned.
 */
export function takePass(cursor: number, count: number, now: number): { pass: Pass; cursor: number } {
  const start = Math.min(Math.max(cursor, now), now + MAX_BACKLOG_MS);
  const limit = now + MAX_BACKLOG_MS;
  let step = STAGGER_MS;
  if (count > 1 && start + (count - 1) * STAGGER_MS > limit) step = start < limit ? Math.max(MIN_STEP_MS, (limit - start) / (count - 1)) : MIN_STEP_MS;
  return { pass: { base: Math.round(start - now), step, count }, cursor: start + count * step };
}

/**
 * The state of the last reply's fade: which words were drawn (by their place in the tree) and the
 * delay each was given, null for one drawn without a fade.
 */
export class WordFade {
  private key: number | null = null;
  private words = 0;
  private cursor = 0;
  private seen = new Map<string, number | null>();
  private pass: Pass = { base: 0, step: 0, count: 0 };
  private started = 0;

  /**
   * Starts an update's pass when the reply drawn at row `key` holds `words` words and held fewer
   * before. A reply on a row that was not there before (`newRow`) fades from its first word; one
   * that was (a send under it dropped) is drawn as it stands. While `still` (the chat was just
   * opened or is hidden) new words are drawn without a fade. Words drawn again in a place not seen
   * before (a fold opened, the row scrolled back in) get no fade unless the reply grew.
   */
  update(key: number | null, words: number, newRow: boolean, still: boolean, now: number): boolean {
    if (key !== this.key) {
      this.key = key;
      this.words = newRow && !still ? 0 : words;
      this.pass = { base: 0, step: 0, count: 0 };
      if (this.seen.size > 20_000) this.seen = new Map();
    }
    if (words === this.words) return false;
    const grew = still ? 0 : Math.max(0, words - this.words);
    this.words = words;
    const taken = takePass(this.cursor, grew, now);
    if (grew > 0) this.cursor = taken.cursor;
    this.pass = taken.pass;
    this.started = 0;
    return true;
  }

  /** The delay of the word drawn at `place`: given once, the first time it is drawn; null draws it as it is. */
  delay(place: string): number | null {
    const known = this.seen.get(place);
    if (known !== undefined) return known;
    const delay = this.started < this.pass.count ? Math.round(this.pass.base + this.started++ * this.pass.step) : null;
    this.seen.set(place, delay);
    return delay;
  }

  /** `text` drawn a span per word, each new one fading in (MarkdownTextContext's drawing). */
  draw(text: string, place: string): ReactNode {
    return splitWords(text).map((word, index) => {
      if (ONLY_SPACE.test(word)) return word;
      const delay = this.delay(`${place}:${index}`);
      return delay === null
        ? createElement("span", { key: index }, word)
        : createElement("span", { key: index, "data-fork-fade": "", style: { animationDelay: `${delay}ms` } }, word);
    });
  }
}

export type DrawText = (text: string, place: string) => ReactNode;

/**
 * The row of `turns` whose words fade in (the last, while it is the agent's and Animated replies
 * is on) and the drawing for its MarkdownTextContext. A reply already there when the chat is
 * opened or shown again is drawn as it stands.
 */
export function useWordFade(turns: readonly ConversationTurn[], on: boolean, visible: boolean): { row: number | null; draw: DrawText } {
  const [fade] = useState(() => new WordFade());
  const draw = useMemo((): DrawText => (text, place) => fade.draw(text, place), [fade]);
  const shownSince = useRef(performance.now());
  const wasVisible = useRef(visible);
  const rows = useRef(turns.length);
  const now = performance.now();
  if (visible && !wasVisible.current) shownSince.current = now;
  wasVisible.current = visible;
  const last = turns.at(-1);
  const row = on && last?.role === "assistant" ? turns.length - 1 : null;
  const words = useMemo(() => row === null ? 0 : turnWords(last), [row, last]);
  fade.update(row, words, turns.length > rows.current, !visible || now - shownSince.current < OPEN_GRACE_MS, now);
  rows.current = turns.length;
  return { row, draw };
}
