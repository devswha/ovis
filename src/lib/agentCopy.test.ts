import { describe, expect, it } from "bun:test";
import { unwrapAgentRows } from "./agentCopy.ts";

describe("unwrapAgentRows", () => {
  it("joins a reply Claude Code wrapped at the pane width into one line (#2558)", () => {
    // the rows the issue copied from a 158-column pane, the first after Claude's "⏺ " marker
    const copied = "Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one line without any\n"
      + "  extra spaces. Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one\n"
      + "  line.";
    expect(unwrapAgentRows(copied, 158, 2)).toBe("Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one line without any extra spaces. Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one line.");
  });

  it("keeps blank lines, short lines and list items that would have fit", () => {
    const copied = "⏺ First paragraph ends here.\n\n  - short item\n  - second item\nplain row";
    expect(unwrapAgentRows(copied, 40)).toBe(copied);
  });

  it("joins a word cut at the edge with no space, and keeps Windows line breaks between kept lines", () => {
    expect(unwrapAgentRows("  https://example.com/a/b\n  /c/d", 24)).toBe("  https://example.com/a/b/c/d");
    expect(unwrapAgentRows("one\r\ntwo", 10)).toBe("one\r\ntwo");
  });

  it("counts a wide character as two cells", () => {
    // 8 Hangul syllables fill 16 cells: the next word could not have fit in 18
    expect(unwrapAgentRows("한국어로쓴문장이\n  다음", 18)).toBe("한국어로쓴문장이 다음");
    expect(unwrapAgentRows("abcdefgh\n  다음", 18)).toBe("abcdefgh\n  다음");
  });
});
