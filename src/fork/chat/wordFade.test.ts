import { describe, expect, test } from "bun:test";

import { splitWords, takePass, WordFade } from "./wordFade.ts";

describe("splitWords", () => {
  test("keeps each word's trailing space and splits CJK by character", () => {
    expect(splitWords("one two  three")).toEqual(["one ", "two  ", "three"]);
    expect(splitWords(" lead")).toEqual([" ", "lead"]);
    expect(splitWords("日本語 ok")).toEqual(["日", "本", "語 ", "ok"]);
  });
});

describe("takePass", () => {
  test("a few words are 100ms apart from now", () => {
    expect(takePass(0, 3, 1000)).toEqual({ pass: { base: 0, step: 100, count: 3 }, cursor: 1300 });
  });

  test("a burst is squeezed into 1000ms", () => {
    const { pass } = takePass(0, 33, 1000);
    expect(pass.base).toBe(0);
    expect(pass.step).toBe(1000 / 32);
  });

  test("the next update starts where the last one's words stop, never past 1000ms out", () => {
    expect(takePass(1120, 2, 1050).pass.base).toBe(70);
    expect(takePass(5000, 2, 1000).pass.base).toBe(1000);
  });
});

describe("WordFade", () => {
  test("only an update's new words fade, each keeping its delay", () => {
    const fade = new WordFade();
    fade.update(0, 2, false, true, 0);
    expect(fade.delay("a")).toBeNull();
    expect(fade.update(0, 4, false, false, 100)).toBe(true);
    expect(fade.delay("b")).toBe(0);
    expect(fade.delay("c")).toBe(100);
    expect(fade.delay("d")).toBeNull();
    expect(fade.delay("b")).toBe(0);
  });

  test("a new reply row fades from its first word; one just opened or shown again does not", () => {
    const fresh = new WordFade();
    fresh.update(3, 1, true, false, 0);
    expect(fresh.delay("x")).toBe(0);
    const opened = new WordFade();
    expect(opened.update(3, 5, true, true, 0)).toBe(false);
    expect(opened.delay("x")).toBeNull();
  });

  test("a row that was there before (a send under it dropped) does not fade again", () => {
    const fade = new WordFade();
    fade.update(1, 2, false, false, 0);
    fade.update(2, 1, true, false, 10);
    fade.update(1, 2, false, false, 20);
    expect(fade.delay("again")).toBeNull();
  });
});
