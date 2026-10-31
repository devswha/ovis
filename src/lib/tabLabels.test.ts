import { afterEach, describe, expect, it } from "bun:test";

import { MAX_TAB_LABEL_LENGTH } from "../../shared/preferences.ts";
import { currentTabLabels, firstPromptLine, firstPromptOf, learnTabLabel, setTabLabels, shortTabLabel } from "./tabLabels.ts";

afterEach(() => setTabLabels({}));

describe("tab labels from the first message", () => {
  it("takes the first line with words, its spaces collapsed, cut to what the server keeps", () => {
    expect(firstPromptLine("\n  \n  Fix   the\tlogin  \nand more")).toBe("Fix the login");
    expect(firstPromptLine("  \n ")).toBeNull();
    const long = firstPromptLine("a".repeat(500))!;
    expect(long.length).toBe(MAX_TAB_LABEL_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("shows a few words, cut at a word's end, or at the limit where no space is near", () => {
    expect(shortTabLabel("Fix the login")).toBe("Fix the login");
    expect(shortTabLabel("Fix the login redirect after the session expires")).toBe("Fix the login redirect…");
    // a wide character takes two columns: Korean shows half as many characters, cut at a space when one is near
    expect(shortTabLabel("로그인리다이렉트를고쳐주세요세션이만료된뒤에도계속")).toBe("로그인리다이렉트를고쳐주…");
    expect(shortTabLabel("로그인 리다이렉트를 고쳐 주세요")).toBe("로그인 리다이렉트를…");
    // an emoji drawn as one character is never split
    expect(shortTabLabel("👩‍💻".repeat(30))).toBe(`${"👩‍💻".repeat(12)}…`);
  });

  it("learns a pane's line once, keyed with its PC", () => {
    expect(learnTabLabel("local", "w1:p1", "Fix the login")).toBe(true);
    expect(learnTabLabel("local", "w1:p1", "Something later")).toBe(false);
    expect(learnTabLabel("pc-2", "w1:p1", "Other PC")).toBe(true);
    expect(learnTabLabel("local", "w1:p3", "   ")).toBe(false);
    expect(currentTabLabels()).toEqual({ "w1:p1": "Fix the login", "remote:pc-2:w1%3Ap1": "Other PC" });
  });

  it("finds the first message with words in turns read from the beginning", () => {
    expect(firstPromptOf([
      { role: "user", ts: null, parts: [{ kind: "image", media_type: "image/png", ref: "r" }] },
      { role: "assistant", ts: null, parts: [{ kind: "text", text: "Hi" }] },
      { role: "user", ts: null, parts: [{ kind: "text", text: "Fix it" }, { kind: "text", text: "now" }] },
    ])).toBe("Fix it\nnow");
    expect(firstPromptOf([{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Hi" }] }])).toBeNull();
  });
});
