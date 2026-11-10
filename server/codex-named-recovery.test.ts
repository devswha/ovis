import { expect, it } from "bun:test";
import { namedCodexAnswerShown, namedCodexAppendCompatible, namedCodexThread } from "./codex.ts";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const name = "Investigate a restored conversation";
const index = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
const row = (id: string, thread_name: string) => ({ id, thread_name });
const message = (role: string, text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const answer = "The restored conversation contains this substantial answer about a precise synchronization boundary and stable terminal identity. This sentence carries enough distinct characters to verify the visible text independently of its saved title.";

it("uses the latest saved name and requires one unique title match", () => {
  expect(namedCodexThread(`${name} | project`, index(row(first, name)))).toBe(first);
  expect(namedCodexThread(`⠋ ${name} | project`, index(row(first, name)))).toBe(first);
  expect(namedCodexThread(`${name} | project`, index(row(first, name), row(second, name)))).toBeNull();
  // a namesake in another folder (not eligible here) may be the thread the pane resumed
  expect(namedCodexThread(`${name} | project`, index(row(first, name), row(second, name)), new Set([first]))).toBeNull();
  expect(namedCodexThread(`${name} | project`, index(row(first, name)), new Set([second]))).toBeNull();
  expect(namedCodexThread(`${name} | project`, index(row(first, name), row(first, "Renamed conversation")))).toBeNull();
  expect(namedCodexThread(`${name} | project`, index(row(first, name), row(second, `${name} | project`)))).toBeNull();
  expect(namedCodexThread(`other ${name} | project`, index(row(first, name)))).toBeNull();
});

it("refuses a cut index, malformed identity, short name or merely similar title", () => {
  expect(namedCodexThread(name, index(row(first, name)) + '\n{"id":')).toBeNull();
  expect(namedCodexThread(name, index(row("not-a-thread", name)))).toBeNull();
  expect(namedCodexThread(`${name} | project`, index(row(first, name), { id: first, thread_name: null }))).toBeNull();
  // a row of another shape elsewhere does not turn recovery off for every pane
  expect(namedCodexThread(`${name} | project`, index(row("not-a-thread", "other"), { id: second }, row(first, name)))).toBe(first);
  expect(namedCodexThread("Hi | project", index(row(first, "Hi")))).toBeNull();
  expect(namedCodexThread(`${name} extra | project`, index(row(first, name)))).toBeNull();
});

it("recognizes the latest answer when a viewport clips its leading bullet", () => {
  const rollout = message("assistant", answer);
  expect(namedCodexAnswerShown(`› a previous question\n\n  ${answer}\n\n  Worked for 9m 40s • Nov 5 at 6:23 PM\n\n› Ask Codex to do anything`, rollout)).toBe(true);
  expect(namedCodexAnswerShown(`• ${answer}`, rollout)).toBe(true);
  expect(namedCodexAnswerShown(`› ${answer}`, rollout)).toBe(false);
  expect(namedCodexAnswerShown(`• Ran command\n  └ ${answer}`, rollout)).toBe(false);
});

it("does not accept an older answer, short common words or repetitive text", () => {
  expect(namedCodexAnswerShown(`• ${answer}`, message("assistant", answer) + "\n" + message("user", "Next") + "\n" + message("assistant", "A different final answer"))).toBe(false);
  expect(namedCodexAnswerShown("• Done", message("assistant", "Done"))).toBe(false);
  expect(namedCodexAnswerShown(`• ${"same".repeat(80)}`, message("assistant", "same".repeat(80)))).toBe(false);
});

it("recognizes a long latest prompt during tool work, but never an earlier prompt", () => {
  const asked = "Please examine the current project records and identify the exact owner of this restored conversation before changing anything";
  expect(namedCodexAnswerShown(`› ${asked.slice(0, 90)}…\n• Ran command\n  └ output`, message("user", asked))).toBe(true);
  expect(namedCodexAnswerShown(`› ${asked}`, message("user", asked) + "\n" + message("assistant", "Done") + "\n" + message("user", "Different request"))).toBe(false);
});

it("uses a whole completed short exchange only alongside independent name identity", () => {
  const screen = "› Hello there\n\n• Hello! How can I help?\n\n  Worked for 4s • 7:05 PM\n\n› Ask Codex to do anything\n\n  GPT-6-Luna low · /project · Context 90% left\n  ← for agents · ? for shortcuts";
  expect(namedCodexAnswerShown(screen, message("user", "Hello there") + "\n" + message("assistant", "Hello! How can I help?"))).toBe(true);
  expect(namedCodexAnswerShown(screen, message("user", "Different greeting") + "\n" + message("assistant", "Hello! How can I help?"))).toBe(false);
});

it("recognizes a complete short latest prompt while only tool output follows", () => {
  const asked = "실행 결과 확인해줘.";
  expect(namedCodexAnswerShown(`› ${asked}   \n    + Show details\n\n• Ran command\n  └ output\n\n› Ask Codex to do anything`, message("user", asked))).toBe(true);
  expect(namedCodexAnswerShown("› 실행 결과 확인해줘.\n• Ran command", message("user", "실행  결과 확인해줘."))).toBe(true);
});

it("rejects short prefixes, clipping, changed punctuation and old prompts", () => {
  const asked = "실행 결과 확인해줘.";
  for (const shown of ["실행 결과", "실행 결과…", "실행 결과 확인해줘?", "Ask Codex to do anything"]) {
    expect(namedCodexAnswerShown(`› ${shown}\n• Ran command`, message("user", asked))).toBe(false);
  }
  expect(namedCodexAnswerShown(`› ${asked}\n• Ran command`, message("user", asked) + "\n" + message("assistant", "Done") + "\n" + message("user", "다른 요청"))).toBe(false);
  expect(namedCodexAnswerShown(`• Ran command\n  └ ${asked}`, message("user", asked))).toBe(false);
});

it("allows an append but refuses replacement and truncation during a named read", () => {
  const before = { dev: 1, ino: 2, size: 100 };
  expect(namedCodexAppendCompatible(before, { ...before, size: 150 })).toBe(true);
  expect(namedCodexAppendCompatible(before, { ...before, size: 100 })).toBe(true);
  expect(namedCodexAppendCompatible(before, { ...before, size: 90 })).toBe(false);
  expect(namedCodexAppendCompatible(before, { ...before, ino: 3 })).toBe(false);
  expect(namedCodexAppendCompatible(before, { ...before, dev: 2 })).toBe(false);
});

it("takes no prompt still in the composer, nor one too short to tell", () => {
  const asked = "Please continue with the restored conversation";
  expect(namedCodexAnswerShown(`› ${asked}\n\n  gpt-5.1-codex default · /project`, message("user", asked))).toBe(false);
  expect(namedCodexAnswerShown("› yes\n• Ran command", message("user", "yes"))).toBe(false);
});

it("takes only the latest sent prompt on screen, not an earlier one a later prompt followed", () => {
  const asked = "Please examine the current project records and identify the exact owner of this restored conversation before changing anything";
  const later = "\n\n• Done.\n\n› a different current request\n\n• Ran command\n  └ output\n\n› Ask Codex to do anything";
  expect(namedCodexAnswerShown(`› test${later}`, message("user", "test"))).toBe(false);
  expect(namedCodexAnswerShown(`› ${asked.slice(0, 90)}…${later}`, message("user", asked))).toBe(false);
  expect(namedCodexAnswerShown("› a different current request\n\n• Ran command", message("user", "a different current request"))).toBe(true);
});

it("takes a clipped prompt only from the start of the latest one, not a part it quotes", () => {
  const asked = "Please examine the current project records and identify the exact owner of this restored conversation before changing anything";
  expect(namedCodexAnswerShown(`› ${asked.slice(16, 106)}…\n• Ran command`, message("user", asked))).toBe(false);
});
