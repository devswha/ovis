import { afterAll, beforeAll, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown, MarkdownTextContext, type MarkdownDraw } from "../../components/Markdown.tsx";
import { SettingsProvider } from "../../lib/settings.ts";
import { turnWords, WordFade } from "./wordFade.ts";

// bun's navigator has no languages; the i18n under the code block's copy button reads them
const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
beforeAll(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
afterAll(() => { if (saved) Object.defineProperty(navigator, "languages", saved); else Reflect.deleteProperty(navigator, "languages"); });

/** The delays in the order the page shows them, each with the element it sits on. */
function fades(text: string): { tag: string; delay: number }[] {
  const fade = new WordFade();
  const words = turnWords({ role: "assistant", parts: [{ kind: "text", text }] } as never);
  fade.update(0, words, true, false, 0);
  const draw: MarkdownDraw = { text: (run, place) => fade.text(run, place), piece: (place) => fade.piece(place) };
  const html = renderToStaticMarkup(<SettingsProvider><MarkdownTextContext.Provider value={draw}><Markdown>{text}</Markdown></MarkdownTextContext.Provider></SettingsProvider>);
  return [...html.matchAll(/<(\w+)[^>]*data-fork-fade=""[^>]*animation-delay:(\d+)ms/g)].map((match) => ({ tag: match[1]!, delay: Number(match[2]) }));
}

it("a bullet, inline code and a code block fade in their turn after the words before them", () => {
  const shown = fades("Some words first.\n\n- item with `code`\n\n```ts\nconst x = 1;\n```\n\nAfter.");
  const delays = shown.map((piece) => piece.delay);
  expect(delays).toEqual([...delays].sort((a, b) => a - b));
  expect(shown.map((piece) => piece.tag)).toEqual(["span", "span", "span", "li", "span", "span", "span", "div", "span"]);
});
