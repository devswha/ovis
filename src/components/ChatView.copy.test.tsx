import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import * as clipboard from "../lib/clipboard.ts";
import * as plainTextModule from "../lib/plainText.ts";
import { Turn } from "./ChatView.tsx";

// Captured at module load, before any spy is installed: the original plain-text implementation,
// so a test can compute legacy output byte-for-byte and wrap the spy without re-entering it.
const originalPlainText = plainTextModule.plainText;

/**
 * TASK-001/TASK-002 baseline and regression gate for an assistant turn's TXT copy button
 * (`docs/plans/performance-optimization-2026-11.md`, AC-002/AC-006): deriving an answer's plain
 * text must happen only when the reader copies it as TXT - never while its row renders - while
 * MD/TXT copies keep byte-for-byte what they always copied of the content visible at activation,
 * including while the turn streams new words in just before the click. Counts are the gate
 * (`plainText` invocations); timing stays an observation recorded under
 * docs/plans/performance-evidence/TASK-COPY/, never asserted on - these are isolated component
 * fixtures on one host, never a claim about any device or session (`docs/performance-audit-2026-10-21.md`).
 */

const descriptors = new Map<string, PropertyDescriptor | undefined>();

function installBrowserGlobals(): void {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  const listen = { addEventListener() {}, removeEventListener() {} };
  // setTimeout/clearTimeout are no-ops: a copy's "Copied" timer must not outlive the fixture
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, writable: true, value: () => style });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { languages: ["en"] } });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { ...listen, setTimeout: () => 0, clearTimeout() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null } });
}

function uninstallBrowserGlobals(): void {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}

/** One assistant turn whose words are its whole content; `ts` null keeps its row free of clocks. */
const assistantTurn = (textParts?: string[]): ConversationTurn => ({ role: "assistant", ts: null, parts: textParts === undefined ? [{ kind: "text", text: "An answer." }] : textParts.map((text) => ({ kind: "text", text })) });

const turnProps = (turn: ConversationTurn) => ({ paneId: "p1", turn, rowKey: "row", live: false, waiting: false, showThinking: false });

const copyButton = (renderer: ReactTestRenderer, label: string): ReactTestInstance => renderer.root.findAll((node) => node.type === "button" && node.props["aria-label"] === label)[0]!;

describe("an assistant turn's TXT copy derives its words only when copied", () => {
  let renderer: ReactTestRenderer | undefined;
  let plainTextSpy: ReturnType<typeof spyOn>;
  let copyTextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    installBrowserGlobals();
    const realPlainText = plainTextModule.plainText; // the original implementation, captured before any spy is installed; the spy counts while delegating to it byte-for-byte
    plainTextSpy = spyOn(plainTextModule, "plainText").mockImplementation((markdown) => realPlainText(markdown));
    copyTextSpy = spyOn(clipboard, "copyText").mockImplementation(() => Promise.resolve(true)); // the clipboard write is observed, not performed (no live browser here)
  });

  afterEach(() => {
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    plainTextSpy.mockRestore();
    copyTextSpy.mockRestore();
    uninstallBrowserGlobals();
  });

  const renderTurn = async (turn: ConversationTurn): Promise<void> => {
    await act(async () => { renderer = create(<SettingsProvider><Turn {...turnProps(turn)} /></SettingsProvider>); });
  };

  const updateTurn = async (turn: ConversationTurn): Promise<void> => {
    await act(async () => { renderer!.update(<SettingsProvider><Turn {...turnProps(turn)} /></SettingsProvider>); });
  };

  const clickCopy = async (label: string): Promise<void> => {
    // onClick is `void copy()`: its synchronous part - deriving plain text and calling copyText - runs
    // inside this act; only its state update (setCopied) settles later as a microtask, which no assertion
    // here depends on
    await act(async () => { copyButton(renderer!, label).props.onClick(); });
  };
  it("renders an answer without deriving its plain text (baseline)", async () => {
    await renderTurn(assistantTurn(["# Plan\n\n**One** step:\n\n```\nrun tests\n```\n\nSee [the docs](https://example.com/docs) for more."])); // markdown with a heading, bold, a code fence and a link (AC-002 content shapes)
    expect(copyButton(renderer!, "Copy as markdown")).toBeDefined(); // both copy buttons are drawn beside the answer's words
    expect(copyButton(renderer!, "Copy as plain text")).toBeDefined();
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // RED before TASK-002: the row derived it on every render; GREEN after: zero until a TXT copy is asked for (AC-002)
  });

  it("streams new words into the answer without deriving its plain text", async () => {
    await renderTurn(assistantTurn(["First words."]));
    await updateTurn(assistantTurn(["First words.", "More words arrive while the turn runs."])); // a streaming update just before the click (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived while the words streamed in or settled into their row
    await clickCopy("Copy as plain text");
    expect(copyTextSpy).toHaveBeenCalledTimes(1); // one clipboard write for one click: the gesture semantics are unchanged (AC-006)
    expect(copyTextSpy).toHaveBeenCalledWith("First words.\n\nMore words arrive while the turn runs."); // the words visible at activation; a settled answer has no markdown to strip here, so plain and markdown agree byte-for-byte (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(1); // derived once, in the click itself - never earlier than that (AC-002)
  });

  it("copies the answer as markdown without deriving its plain text", async () => {
    const answer = "**Bold** and [a link](https://example.com) and `code`."; // a markdown answer whose plain form differs from it (AC-002)
    await renderTurn(assistantTurn([answer])); // a TXT copy beside it must not pay for a plain-text pass either (AC-006)
    await clickCopy("Copy as markdown"); // the MD copy needs no plain-text pass at all (AC-002)
    expect(copyTextSpy).toHaveBeenCalledTimes(1); // one clipboard write for one click (AC-006)
    expect(copyTextSpy).toHaveBeenCalledWith(answer); // byte-for-byte what the MD copy always copied (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived on render and nothing needed for markdown (AC-002)
  });

  it("derives its plain text once in the click handler, before the clipboard write", async () => {
    const answer = "# Heading\n\n> quoted\n~~gone~~ and **kept**."; // legacy output below is computed from the original implementation either way - byte-for-byte (AC-002)
    const order: string[] = []; // a synchronous derivation inside the gesture must precede the clipboard write it feeds (DESIGN-002)
    plainTextSpy.mockImplementation((markdown: string) => { order.push("derive"); return originalPlainText(markdown); }); // record the derivation's moment inside the gesture; delegate to the original, not the spy
    copyTextSpy.mockImplementation((text: string) => { order.push("copy"); return Promise.resolve(true); }); // record the clipboard write's moment inside the gesture (no live clipboard here)
    await renderTurn(assistantTurn([answer])); // a markdown answer whose plain form differs from it (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived while the row rendered (AC-002)
    await clickCopy("Copy as plain text"); // one click: derive, then write - in that order (DESIGN-002)
    expect(copyTextSpy).toHaveBeenCalledTimes(1); // one clipboard write for one click (AC-006)
    expect(copyTextSpy).toHaveBeenCalledWith(originalPlainText(answer)); // byte-for-byte the original implementation's plain form (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(1); // derived exactly once, in the click itself (AC-002)
    expect(order).toEqual(["derive", "copy"]); // the derivation ran synchronously inside the gesture, before the clipboard write it fed (DESIGN-002)
  });

  it("shows no copy buttons for an empty answer, so nothing is derived", async () => {
    await renderTurn({ role: "assistant", ts: null, parts: [{ kind: "text", text: "" }] }); // an answer with no words (AC-002 boundary)
    expect(copyButton(renderer!, "Copy as markdown")).toBeUndefined(); // the copy row is drawn only beside words (AC-006)
    expect(copyButton(renderer!, "Copy as plain text")).toBeUndefined();
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived for an empty answer (AC-002)
  });

  it("copies a large answer with CJK, emoji, code and links byte-for-byte, deriving once in the click", async () => {
    const answer = ["# 計畫 Plan", "", "**重點** key points:", "", "```", "const n = 42; // 計算", "console.log(n);", "```", "", "- [文件](https://example.com/docs) 🎉", "- 中文與 emoji 🚀 mixed", "", "tail".repeat(4096)].join("\n"); // a large answer mixing CJK, emoji, a code fence and a link (AC-002 content shapes)
    await renderTurn(assistantTurn([answer])); // a long answer must not pay a plain-text pass while it renders (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(0); // nothing derived while the row rendered (AC-002)
    await clickCopy("Copy as plain text"); // one click: derive once, write once (AC-006)
    expect(copyTextSpy).toHaveBeenCalledTimes(1); // one clipboard write for one click (AC-006)
    expect(copyTextSpy).toHaveBeenCalledWith(originalPlainText(answer)); // byte-for-byte the original implementation's plain form (AC-002)
    expect(plainTextSpy).toHaveBeenCalledTimes(1); // derived exactly once, in the click itself (AC-002)
  });
});