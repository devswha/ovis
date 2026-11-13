import { describe, expect, it } from "bun:test";
import { readLink } from "./deepLink.ts";
import { inboxAddress, inboxModeRead, startsInInbox, withInboxAddress } from "./inboxMode.ts";
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

describe("where a device that starts in the inbox starts", () => {
  it("starts in the mode on a phone whose address is the app's own start, or names a pane", () => {
    expect(startsInInbox(true, true, null)).toBe(true);
    expect(startsInInbox(true, true, readLink("?pane=w1%3Ap1&view=chat"))).toBe(true);
    // Settings open at the start, or a New workspace link, is still the app's own start under it
    expect(startsInInbox(true, true, readLink("?settings=appearance"))).toBe(true);
  });

  it("opens an address that names only a workspace or an absolute file as it always did", () => {
    expect(startsInInbox(true, true, readLink("?ws=w1-api"))).toBe(false);
    expect(startsInInbox(true, true, readLink("?file=%2Fhome%2Fme%2Fplan.md"))).toBe(false);
  });

  it("starts in the classic app in a window wider than a phone, and with the setting off", () => {
    expect(startsInInbox(true, false, null)).toBe(false);
    expect(startsInInbox(false, true, null)).toBe(false);
    expect(startsInInbox(false, true, readLink("?pane=w1%3Ap1"))).toBe(false);
  });
});
