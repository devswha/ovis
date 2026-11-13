import { describe, expect, it } from "bun:test";
import { inboxAddress, inboxModeRead, withInboxAddress } from "./inboxMode.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";

describe("the inbox mode's address", () => {
  it("is the app parameter saying inbox, and nothing else", () => {
    expect(inboxAddress("?app=inbox")).toBe(true);
    expect(inboxAddress("?ws=w1-api&pane=p1&app=inbox&view=chat")).toBe(true);
    expect(inboxAddress("")).toBe(false);
    expect(inboxAddress("?app=classic")).toBe(false);
    expect(inboxAddress("?inbox=1")).toBe(false);
  });

  it("is set and dropped with every other parameter left as it was", () => {
    expect(withInboxAddress("", true)).toBe("?app=inbox");
    expect(withInboxAddress("?ws=w1-api&pane=p1&view=chat", true)).toBe("?ws=w1-api&pane=p1&view=chat&app=inbox");
    expect(withInboxAddress("?app=inbox&ws=w1-api&pane=p1&view=chat", false)).toBe("?ws=w1-api&pane=p1&view=chat");
    expect(withInboxAddress("?app=inbox", false)).toBe("");
    expect(withInboxAddress("?app=inbox&pane=p1", true)).toBe("?app=inbox&pane=p1");
    expect(withInboxAddress("?pane=p1", false)).toBe("?pane=p1");
  });

  it("leaves another value of the parameter alone when the mode is left", () => {
    expect(withInboxAddress("?app=other&pane=p1", false)).toBe("?app=other&pane=p1");
  });

  it("rides in the hosted shell's fragment with the rest of the page's query", () => {
    const scope = `/s/${"ab".repeat(16)}/`;
    const address = pageAddress(scope, withInboxAddress("?pane=p1", true), "", "relay");
    expect(address).toBe(`${scope}#pane=p1&app=inbox`);
    expect(inboxAddress(pageSearch({ search: "", hash: new URL(address, "https://app.example").hash }, "relay"))).toBe(true);
  });
});

describe("the gate on the mode's address", () => {
  it("reads the address when the mode is offered, or in a build with test hooks", () => {
    expect(inboxModeRead(true, false)).toBe(true);
    expect(inboxModeRead(false, true)).toBe(true);
    expect(inboxModeRead(false, false)).toBe(false);
  });
});
