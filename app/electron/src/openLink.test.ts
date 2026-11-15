import { describe, expect, it } from "bun:test";
import { argvLinkQuery, openLinkQuery } from "./openLink.ts";

describe("openLinkQuery", () => {
  it("passes on a pane's place as the deep link's own query", () => {
    expect(openLinkQuery("ovis://open?ws=3&pane=t3&view=terminal")).toBe("?ws=3&pane=t3&view=terminal");
    expect(openLinkQuery("ovis://open/?pane=t3&view=chat&ws=3-my-app&machine=home%20pc")).toBe("?machine=home+pc&ws=3-my-app&pane=t3&view=chat");
    expect(openLinkQuery("OVIS://OPEN?pane=t3")).toBe("?pane=t3");
  });

  it("keeps only the names of a pane's place", () => {
    expect(openLinkQuery("ovis://open?pane=t3&file=/etc/passwd&settings=access&new=workspace&cwd=/&token=x#frag")).toBe("?pane=t3");
  });

  it("refuses a link that names no pane", () => {
    expect(openLinkQuery("ovis://open?ws=3")).toBeNull();
    expect(openLinkQuery("ovis://open?pane=%20")).toBeNull();
    expect(openLinkQuery("ovis://open")).toBeNull();
  });

  it("refuses anything but ovis://open", () => {
    for (const value of [
      "https://example.com/?pane=t3",
      "http://127.0.0.1:7317/?pane=t3",
      "javascript:alert(1)//?pane=t3",
      "file:///?pane=t3",
      "ovis://evil.example?pane=t3",
      "ovis://open.example.com?pane=t3",
      "ovis://user@open?pane=t3",
      "ovis://open:80?pane=t3",
      "ovis://open/api/pane/close?pane=t3",
      "ovis:open?pane=t3",
      "?pane=t3",
      "not a link",
      "",
    ]) expect(openLinkQuery(value)).toBeNull();
  });

  it("refuses a view the page does not draw, a control character and an overlong value", () => {
    expect(openLinkQuery("ovis://open?pane=t3&view=files")).toBeNull();
    expect(openLinkQuery("ovis://open?pane=t3%0A")).toBe("?pane=t3");
    expect(openLinkQuery("ovis://open?pane=t%0A3")).toBeNull();
    expect(openLinkQuery(`ovis://open?pane=${"a".repeat(257)}`)).toBeNull();
  });
});

describe("argvLinkQuery", () => {
  it("reads the link a start was handed", () => {
    expect(argvLinkQuery(["C:\\Ovis\\Ovis.exe", "--", "ovis://open?ws=1&pane=p2&view=chat"])).toBe("?ws=1&pane=p2&view=chat");
    expect(argvLinkQuery(["/usr/bin/ovis", "--no-sandbox", "ovis://open/?pane=t3"])).toBe("?pane=t3");
  });

  it("finds nothing in a plain start or a link it refuses", () => {
    expect(argvLinkQuery(["/usr/bin/ovis"])).toBeNull();
    expect(argvLinkQuery(["/usr/bin/ovis", "--open=?pane=t3"])).toBeNull();
    expect(argvLinkQuery(["/usr/bin/ovis", "ovis://elsewhere?pane=t3"])).toBeNull();
  });
});
