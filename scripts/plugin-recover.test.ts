/**
 * The `ovis recover` command (device-row-states rows T70, R11, N6, E41, E46): it lists the rows that wait for a whole
 * read, releases the ones its user names one at a time at a terminal, and undoes releases.
 */
import { expect, test } from "bun:test";
import type { RecoveryAction } from "../shared/account-devices-api.ts";
import { runRecover, type RecoverIo } from "./plugin-recover.ts";

const rows = [
  { id: "a1", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up", last_seen_at: "2026-11-19T10:00:00Z", refusal: null },
  { id: "b2", label: "Old laptop", origin: { from: "legacy", how: "legacy" }, waiting: "catching_up", last_seen_at: null, refusal: "frozen" },
];

function io(options: { terminal?: boolean; answers?: string[]; platform?: NodeJS.Platform; unreachable?: boolean; undoWarning?: string; writeError?: string } = {}) {
  const sent: RecoveryAction[] = [];
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
      switch (request.act) {
        case "list": return { rows, pending: [{ id: "0123456789abcdef0123456789abcdef", label: "New phone", fingerprint: "AB12-CD34" }] };
        case "release": return { released: request.rows };
        case "undo": return { releases: ["r1"], ...(options.undoWarning ? { warning: options.undoWarning } : {}) };
        case "admit": return { admitted: "fedcba9876543210" };
        case "remove": return options.writeError ? { error: options.writeError } : { removed: ["a1"] };
        case "lift": return options.writeError ? { error: options.writeError } : { lifted: request.blocks };
        case "revoke_all": return options.writeError ? { error: options.writeError } : { revoked: 2 };
      }
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

test("T70: an undo whose journal entry could not be written says so, and fails", async () => {
  const run = io({ undoWarning: "The undo was not journalled: disk full" });
  expect(await runRecover(["--undo"], run.value)).toBe(1);
  expect(run.text()).toContain("The undo was not journalled: disk full");
});

test("P22/T70: admit shows the waiting device's fingerprint and sends it only after the terminal confirms it", async () => {
  const run = io({ answers: ["y"] });
  expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], run.value)).toBe(0);
  expect(run.text()).toContain("AB12-CD34");
  expect(run.text()).toContain("New phone");
  expect(run.sent.at(-1)).toEqual({ act: "admit", pending: "0123456789abcdef0123456789abcdef", fingerprint: "AB12-CD34" });
});

test("P22: admit answered with anything but yes sends nothing, and needs a terminal", async () => {
  const declined = io({ answers: ["n"] });
  expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], declined.value)).toBe(0);
  expect(declined.sent.some((request) => (request as { act: string }).act === "admit")).toBe(false);
  const piped = io({ terminal: false, answers: ["y"] });
  expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], piped.value)).toBe(1);
  expect(piped.sent).toEqual([]);
});

for (const { row, args, confirmed, answers, result } of [
  { row: "T37", args: ["--remove", "key-a", "a1"], answers: ["", "y"], confirmed: { act: "remove", targets: ["a1"] }, result: /removed.*a1/i },
  { row: "T69", args: ["--lift", "block-a", "block-b"], answers: ["n", "yes"], confirmed: { act: "lift", blocks: ["block-b"] }, result: /lifted.*block-b/i },
  { row: "T70", args: ["--revoke-all"], answers: ["y"], confirmed: { act: "revoke_all" }, result: /revoked.*2/i },
] as const) {
  test(`${row}: ${args[0]} asks before sending only confirmed targets and shows the reply`, async () => {
    const run = io({ answers: [...answers] });
    expect(await runRecover(args, run.value)).toBe(0);
    expect(run.sent).toEqual([confirmed]);
    const prompts = run.text().split("\n").filter((line) => line.includes("[y/N]"));
    expect(prompts).toHaveLength(answers.length);
    if (args[0] === "--revoke-all") expect(prompts[0]).toMatch(/every device.*this PC.*signed out/i);
    else for (const [index, target] of args.slice(1).entries()) expect(prompts[index]).toContain(target);
    expect(run.text()).toMatch(result);
  });

  test(`${row}: ${args[0]} does not write without a terminal or confirmation`, async () => {
    const piped = io({ terminal: false, answers: ["y", "y"] });
    expect(await runRecover(args, piped.value)).toBe(1);
    expect(piped.sent).toEqual([]);
    expect(piped.text()).toContain("not run in a terminal");
    expect(piped.text()).not.toContain("[y/N]");

    const declined = io();
    expect(await runRecover(args, declined.value)).toBe(0);
    expect(declined.sent).toEqual([]);
  });

  test(`${row}: ${args[0]} prints a server error and exits 1`, async () => {
    const run = io({ answers: [...answers], writeError: "log_unreadable" });
    expect(await runRecover(args, run.value)).toBe(1);
    expect(run.text()).toContain("log_unreadable");
    expect(run.text()).not.toMatch(result);
  });
}
