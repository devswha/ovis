import { describe, expect, test } from "bun:test";
import { stablePrefix, wordCut } from "./streamReveal.ts";

const held = (text: string) => text.slice(0, stablePrefix(text, text.length, false));

describe("half-written markdown", () => {
  test("waits for its closing marks", () => {
    expect(held("Some **bold")).toBe("Some ");
    expect(held("Some **bold** and")).toBe("Some **bold** and");
    expect(held("See [the doc")).toBe("See ");
    expect(held("See [the doc](http://x")).toBe("See ");
    expect(held("See [the doc](http://x) now")).toBe("See [the doc](http://x) now");
    expect(held("Use `bun")).toBe("Use ");
    expect(held("Done.\n\n-")).toBe("Done.\n\n");
    expect(held("Done.\n\n| a | b |")).toBe("Done.\n\n");
  });

  test("leaves text that only looks like it", () => {
    for (const text of ["2 * 3 = 6", "a snake_case_name", "Done.\n\n```ts\nconst a = `x", "See [1] and more", "**bold**"]) expect(held(text)).toBe(text);
    expect(stablePrefix("Some **bold", 11, true)).toBe(11);
  });

  test("a cut ends on a whole word until the text is done", () => {
    expect(wordCut("one two thr", 11, false)).toBe(7);
    expect(wordCut("one two thr", 11, true)).toBe(11);
    expect(wordCut("one two thr", 5, false)).toBe(3);
  });
});
