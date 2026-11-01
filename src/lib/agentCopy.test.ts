import { describe, expect, it } from "bun:test";
import { unwrapAgentRows } from "./agentCopy.ts";

describe("unwrapAgentRows", () => {
  it("joins a reply Claude Code wrapped at the pane width into one line (#2558)", () => {
    // the rows the issue copied from a 158-column pane, the first after Claude's "⏺ " marker
    const copied = "Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one line without any\n"
      + "  extra spaces. Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one\n"
      + "  line.";
    expect(unwrapAgentRows(copied, 158, 2)).toBe("Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one line without any extra spaces. Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one line.");
    expect(unwrapAgentRows("⏺ The reply wraps\n  here.", 18)).toBe("⏺ The reply wraps here.");
    expect(unwrapAgentRows("  - a list item wraps\n    on.\n  - next", 21)).toBe("  - a list item wraps on.\n  - next");
  });

  it("keeps blank lines, short lines, list items, deeper code lines, tables and rows wider than the pane", () => {
    const kept = [
      "⏺ First paragraph ends here.\n\n  - short item\n  - second item\nplain row",
      "  - the first item reaches\n  - the next item",
      "  const value = compute(a, b)\n    return value;",
      "  │ name   │ value │\n  │ second │ row   │",
      "  a row drawn wider before a resize\n  - next item",
    ];
    for (const copied of kept) expect(unwrapAgentRows(copied, 30)).toBe(copied);
  });

  it("joins a word cut at the edge with no space, and keeps Windows line breaks between kept lines", () => {
    expect(unwrapAgentRows("  https://example.com/a/b\n  /c/d", 25)).toBe("  https://example.com/a/b/c/d");
    expect(unwrapAgentRows("  See https://exampl\n  e.com/path", 20)).toBe("  See https://example.com/path");
    expect(unwrapAgentRows("  See the long word\n  continues", 19)).toBe("  See the long word continues");
    expect(unwrapAgentRows("one\r\ntwo", 10)).toBe("one\r\ntwo");
  });

  it("counts a wide character as two cells, and joins wide text with no space", () => {
    // after a 2-cell marker, 8 Hangul syllables reach cell 18: the next word could not have fit in 20
    expect(unwrapAgentRows("한국어로쓴문장이\n  다음", 20, 2)).toBe("한국어로쓴문장이 다음");
    expect(unwrapAgentRows("abcdefgh\n  다음", 20, 2)).toBe("abcdefgh\n  다음");
    expect(unwrapAgentRows("  これは折り返されま\n  す。", 22)).toBe("  これは折り返されます。");
  });
});
