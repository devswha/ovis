import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useAnnouncedText } from "./useAnnouncedText.ts";

function StatusLine({ text }: { text: string | null }) {
  const shown = useAnnouncedText(text);
  return createElement("p", { className: shown === null ? "visually-hidden" : "tree-state", role: "status" }, shown);
}

describe("useAnnouncedText", () => {
  it("renders the status box without its words on the render that mounts it", () => {
    expect(renderToStaticMarkup(createElement(StatusLine, { text: "Loading workspaces…" }))).toBe('<p class="visually-hidden" role="status"></p>');
  });

  it("renders nothing for a line that has no words yet", () => {
    expect(renderToStaticMarkup(createElement(StatusLine, { text: null }))).toBe('<p class="visually-hidden" role="status"></p>');
  });
});
