/**
 * The `ovis recover` command (device-row-states rows T70, R11, N6, E41, E46): it lists the rows that wait for a whole
 * read, releases the ones its user names one at a time at a terminal, and undoes releases.
 */
import { expect, test } from "bun:test";
import { runRecover, type RecoverIo } from "./plugin-recover.ts";

const rows = [
  { id: "a1", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up", last_seen_at: "2026-11-19T10:00:00Z", refusal: null },
  { id: "b2", label: "Old laptop", origin: { from: "legacy", how: "legacy" }, waiting: "catching_up", last_seen_at: null, refusal: "frozen" },
];

function io(options: { terminal?: boolean; answers?: string[]; platform?: NodeJS.Platform; unreachable?: boolean } = {}) {
  const sent: unknown[] = [];
  const out: string[] = [];
  const answers = [...(options.answers ?? [])];
  const value: RecoverIo = {
    out: (text) => { out.push(text); },
    terminal: options.terminal ?? true,
    platform: options.platform ?? "linux",
    ask: async (question) => { out.push(question); return answers.shift() ?? ""; },
    send: async (request) => {
      if (options.unreachable) throw new Error("ENOENT");
      sent.push(request);
      if (request.act === "list") return { rows };
      if (request.act === "release") return { released: request.rows };
      return { releases: ["r1"] };
    },
  };
  return { value, sent, text: () => out.join("") };
}

test("T70: recover lists the rows that wait, how each came in, and whether it can be released", async () => {
  const run = io();
  expect(await runRecover([], run.value)).toBe(0);
  expect(run.sent).toEqual([{ act: "list" }]);
  expect(run.text()).toContain("Phone");
  expect(run.text()).toContain("a1");
  expect(run.text()).toContain("remote/list");
  expect(run.text()).toContain("Old laptop");
  expect(run.text()).toContain("frozen");
});

test("T70: release asks for each named row at a terminal and releases only the ones confirmed", async () => {
  const run = io({ answers: ["y"] });
  expect(await runRecover(["--release", "a1", "b2", "zz"], run.value)).toBe(1);
  expect(run.sent).toEqual([{ act: "list" }, { act: "release", rows: ["a1"] }]);
  expect(run.text()).toContain("b2");
  expect(run.text()).toContain("zz");
});

test("T70: an answer other than yes releases nothing", async () => {
  const run = io({ answers: ["n"] });
  expect(await runRecover(["--release", "a1"], run.value)).toBe(0);
  expect(run.sent).toEqual([{ act: "list" }]);
});

test("T70: input that is not a terminal answers nothing", async () => {
  const run = io({ terminal: false, answers: ["y"] });
  expect(await runRecover(["--release", "a1"], run.value)).toBe(1);
  expect(run.sent).toEqual([]);
  expect(run.text()).toContain("terminal");
});

test("T70: undo ends the named releases, or every release", async () => {
  const named = io();
  expect(await runRecover(["--undo", "a1"], named.value)).toBe(0);
  expect(named.sent).toEqual([{ act: "undo", rows: ["a1"] }]);
  const every = io();
  expect(await runRecover(["--undo"], every.value)).toBe(0);
  expect(every.sent).toEqual([{ act: "undo", rows: null }]);
});

test("R11: on Windows recover opens nothing and names the desktop app's screen", async () => {
  const run = io({ platform: "win32" });
  expect(await runRecover([], run.value)).toBe(1);
  expect(run.sent).toEqual([]);
  expect(run.text()).toContain("desktop app");
});

test("R11: a server that does not answer on its recovery socket is said to", async () => {
  const run = io({ unreachable: true });
  expect(await runRecover([], run.value)).toBe(1);
  expect(run.text()).toContain("recovery socket");
});
