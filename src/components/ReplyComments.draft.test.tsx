import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, useRef } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { replyComments } from "../lib/replyComments.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ReplyCommentAction } from "./ReplyComments.tsx";

const KEY = "ovis:reply-comments:test-pane";
const QUOTE = "the quoted words";
const DRAFT_KEY = `ovis:reply-comment-draft:${KEY}\n${QUOTE}`;

/** One split slot showing the pane's chat: its own scroller and its own comment layer. */
function Slot({ name }: { name: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  return <div data-slot={name}>
    <div ref={scroller}><div className="chat-turn-agent"><div className="markdown"><p>{QUOTE}</p></div></div></div>
    <ReplyCommentAction scroller={scroller} storageKey={KEY} paneKey={null} />
  </div>;
}

describe("reply comment drafts in two split slots of one pane", () => {
  let page: Page;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    page = openPage("http://ovis.test/");
    for (const key of ["localStorage", "sessionStorage", "HTMLElement", "Element", "Node", "Text", "NodeFilter", "getSelection", "getComputedStyle", "matchMedia", "requestAnimationFrame"] as const) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value: (page.window as unknown as Record<string, unknown>)[key] });
    }
  });
  afterEach(async () => {
    await page.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const slot = (name: string): Element => document.querySelector(`[data-slot="${name}"]`)!;
  const openForm = async (name: string) => {
    const words = slot(name).querySelector(".markdown p")!;
    const range = document.createRange();
    range.selectNodeContents(words);
    await act(async () => {
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new page.window.Event("selectionchange") as unknown as Event);
    });
    const offer = slot(name).querySelector<HTMLButtonElement>(".reply-comment-offer");
    if (offer === null) throw new Error(`no Comment offer in slot ${name}`);
    await act(async () => { offer.click(); });
    return slot(name).querySelector<HTMLTextAreaElement>(".reply-comment-field")!;
  };
  const press = async (name: string, label: string) => {
    const button = [...slot(name).querySelectorAll<HTMLButtonElement>(".reply-comment-actions button")].find((b) => b.textContent === label)!;
    await act(async () => { button.click(); });
  };

  it("closing the older form keeps the edits made in the other slot (#3466 item 1)", async () => {
    await page.render(<SettingsProvider><Slot name="a" /><Slot name="b" /></SettingsProvider>);
    await page.type(await openForm("a"), "first");
    const b = await openForm("b");
    expect(b.value).toBe("first");
    await page.type(b, "first, then more");
    await press("a", "Cancel");
    expect(sessionStorage.getItem(DRAFT_KEY)).toBe("first, then more");
  });

  it("a comment saved in one slot is not brought back as a draft by closing the other (#3466 item 2, same window)", async () => {
    await page.render(<SettingsProvider><Slot name="a" /><Slot name="b" /></SettingsProvider>);
    await page.type(await openForm("a"), "the comment");
    await openForm("b");
    await press("a", "Save");
    expect(replyComments.read(KEY).map((c) => c.comment)).toEqual(["the comment"]);
    await press("b", "Cancel");
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect((await openForm("a")).value).toBe("");
  });
});
