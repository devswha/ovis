import { afterEach, describe, expect, it } from "bun:test";
import { attachPickedElement, clearPendingComposerFiles, dataUrlToPngFile, elementSelector, onComposerFiles, pickedElementBlock } from "./browserPick.ts";
import { MAX_COMPOSER_CHARS } from "./compose.ts";
import { composerDraftKey, composerDrafts } from "./composerDraft.ts";
import type { PickedBrowserElement } from "./desktopBrowser.ts";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const sample: PickedBrowserElement = {
  address: "http://localhost:5173/checkout",
  title: "Checkout",
  tag: "button",
  role: "button",
  id: "pay-btn",
  classes: ["btn", "btn-primary"],
  name: "Continue to payment",
  text: "Continue",
  rect: { x: 24, y: 120, width: 210, height: 40 },
  imageDataUrl: TINY_PNG,
};

afterEach(() => {
  clearPendingComposerFiles();
});

describe("browserPick", () => {
  it("formats a compact selector and safe composer block", () => {
    expect(elementSelector(sample)).toBe("button#pay-btn.btn.btn-primary");
    expect(pickedElementBlock(sample)).toBe([
      "Picked element on http://localhost:5173/checkout",
      '<button#pay-btn.btn.btn-primary> (role="button", name="Continue to payment", 210×40)',
      "> Continue",
    ].join("\n"));
  });

  it("omits duplicate text line when visible text equals accessible name and collapses newlines", () => {
    const block = pickedElementBlock({
      ...sample,
      role: "",
      id: "",
      classes: [],
      name: "Submit\norder",
      text: "Submit   order",
    });
    expect(block).toBe([
      "Picked element on http://localhost:5173/checkout",
      '<button> (name="Submit order", 210×40)',
    ].join("\n"));
  });

  it("decodes PNG data URLs into File objects and rejects non-PNG strings", () => {
    const file = dataUrlToPngFile(TINY_PNG);
    expect(file).not.toBeNull();
    expect(file?.type).toBe("image/png");
    expect(file?.name).toBe("picked-element.png");
    expect(file?.size).toBeGreaterThan(0);
    expect(dataUrlToPngFile("data:text/html;base64,PGI+")).toBeNull();
    expect(dataUrlToPngFile("not-a-data-url")).toBeNull();
  });

  it("appends the block into the pane draft and delivers the screenshot to the composer", () => {
    const paneKey = "local:picker-test-pane";
    const key = composerDraftKey(paneKey);
    composerDrafts.set(key, "", "replace");

    const received: File[] = [];
    const stop = onComposerFiles(paneKey, (files) => received.push(...files));
    try {
      expect(attachPickedElement(paneKey, sample)).toBe(true);
      expect(composerDrafts.read(key).text).toContain("Picked element on http://localhost:5173/checkout");
      expect(composerDrafts.isAgentOnly(key)).toBe(true);
      expect(received.length).toBe(1);
      expect(received[0]?.type).toBe("image/png");
    } finally {
      stop();
      composerDrafts.set(key, "", "replace");
    }
  });

  it("queues the screenshot until Composer mounts and refuses when the draft is full", () => {
    const paneKey = "local:picker-queue-pane";
    const key = composerDraftKey(paneKey);
    composerDrafts.set(key, "", "replace");
    expect(attachPickedElement(paneKey, sample)).toBe(true);
    const drained: File[] = [];
    const stop = onComposerFiles(paneKey, (files) => drained.push(...files));
    stop();
    expect(drained.length).toBe(1);

    composerDrafts.set(key, "x".repeat(MAX_COMPOSER_CHARS), "replace");
    expect(attachPickedElement(paneKey, sample)).toBe(false);
    composerDrafts.set(key, "", "replace");
  });
});
