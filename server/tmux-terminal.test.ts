import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import type { ProcessInfo } from "./herdr/client.ts";
import { parseTerminalProcesses, type TerminalProcess } from "./kiro-terminal.ts";
import { tmuxCodexProcess as discoverTmux, tmuxWrapper } from "./tmux-terminal.ts";

// Synthetic interpreter PIDs must never read the host's argv unless a test supplies its own reader.
const tmuxCodexProcess: typeof discoverTmux = (info, platform, clients, rows, birth, argv = () => null) =>
  discoverTmux(info, platform, clients, rows, birth, argv);

const info = { foreground_processes: [{ pid: 10, argv: ["tmux", "-S", "/fixture/tmux.sock", "attach-session", "-t", "old-name"] }] } as ProcessInfo;
const mapping = "10\t/dev/pts/1\t11\t/fixture/tmux.sock\t$2\t@3\t%4\t20\t/dev/pts/2\t0\t0\n";
const processes: TerminalProcess[] = [
  { pid: 10, parent: 1, group: 10, foreground: 10, tty: "pts/1", command: "tmux: client" },
  { pid: 11, parent: 1, group: 11, foreground: -1, tty: "?", command: "tmux: server" },
  { pid: 20, parent: 11, group: 20, foreground: 30, tty: "pts/2", command: "/bin/bash" },
  { pid: 30, parent: 20, group: 30, foreground: 30, tty: "pts/2", command: "/opt/bin/codex" },
];
const births = (pid: number) => pid * 100;
const wrapped = processes.map((row) => row.pid === 20 ? { ...row, foreground: 25 }
  : row.pid === 30 ? { ...row, parent: 25, group: 25, foreground: 25 } : row)
  .concat({ pid: 25, parent: 20, group: 25, foreground: 25, tty: "pts/2", command: "/bin/sh" });

describe("tmux native process proof", () => {
  it.skipIf(process.platform !== "linux").each([
    ["node\0codex.js\0", true, false], ["node\0codex.js\0\0", true, true],
    ["node\0\0codex.js\0", false, false], ["node\0codex.js", false, false], ["", false, false],
  ] as const)("reads complete Linux NUL argv without dropping empty words %j", async (text, accepted, emptyLast) => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "fixture-title" } : row);
    const read = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor) => {
      if (path === "/proc/30/cmdline") return text;
      throw new Error("unexpected host file read");
    }) as typeof fs.readFileSync);
    try {
      const found = await discoverTmux(info, "linux", async () => mapping, async () => rows, births);
      expect(found?.pid ?? null).toBe(accepted ? 30 : null);
      if (accepted) expect(found!.argv.at(-1) === "").toBe(emptyLast);
    } finally { read.mockRestore(); }
  });

  it.each(["node", "MainThread", "fixture-title"])("recognizes interpreter argv despite comm %s", async (command) => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command } : row);
    const found = await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      () => ["/usr/bin/node", "/fixture/codex.js", ""]);
    expect(found).toMatchObject({ pid: 30, argv: ["/usr/bin/node", "/fixture/codex.js", ""] });
    expect(found!.identity).not.toContain("/fixture/codex.js");
  });

  it.each([
    null, [], ["node", "", "codex.js"], ["node", "other.js", "codex.js"],
    ["node", "-e", "codex.js"], ["node", "--require=hook", "codex.js"],
    ["node", "--import", "codex.js"], ["sh", "-c", "codex.js"],
  ].map((argv) => [argv] as const))("refuses missing or non-script interpreter argv %j", async (argv) => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "node" } : row);
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births, () => argv)).toBeNull();
  });

  it("refuses interpreter argv or birth changing while it is observed", async () => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "node" } : row);
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      () => ["node", "codex.js", String(++reads)])).toBeNull();
    let generation = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows,
      (pid) => births(pid) + (pid === 30 ? generation : 0),
      () => { generation++; return ["node", "codex.js"]; })).toBeNull();
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      () => { throw new Error("denied"); })).toBeNull();
  });

  it("uses argv in an opaque binding key without exposing its values", async () => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "node" } : row);
    let argument = "fixture-argument-one";
    const read = () => tmuxCodexProcess(info, "darwin", async () => mapping, async () => rows, births,
      () => ["node", "/fixture/codex.js", argument]);
    const first = await read(); argument = "fixture-argument-two";
    const second = await read();
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(second!.identity).not.toBe(first!.identity);
    expect(first!.identity).not.toContain("fixture-argument-one");
    expect(second!.identity).not.toContain("fixture-argument-two");
  });

  it("keeps native positives without reading interpreter argv, but refuses two script candidates", async () => {
    expect((await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, births,
      () => { throw new Error("native must not read argv"); }))?.pid).toBe(30);
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "node" } : row)
      .concat({ ...processes[3]!, pid: 31, command: "node" });
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      () => ["node", "codex.js"])).toBeNull();
  });

  const outerInfo = { ...info, shell_pid: 8, foreground_processes: [
    { pid: 8, argv: ["/bin/sh", "-c", "fixture"] }, { pid: 9, argv: ["/bin/sh", "-c", "fixture"] },
    ...info.foreground_processes!,
  ] } as ProcessInfo;
  const outerRows: TerminalProcess[] = [
    ...wrapped.filter((row) => row.pid !== 10),
    { pid: 8, parent: 1, group: 8, foreground: 8, tty: "pts/1", command: "/bin/sh" },
    { pid: 9, parent: 8, group: 8, foreground: 8, tty: "pts/1", command: "/bin/sh" },
    { ...processes[0]!, parent: 9, group: 8, foreground: 8 },
  ];

  it("proves the complete outer shell chain before selecting its tmux attachment", async () => {
    expect(tmuxWrapper(outerInfo)).toBe(true);
    const found = await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows, births);
    expect(found).toMatchObject({ pid: 30, argv: ["/opt/bin/codex"] });
    expect(found!.identity).toContain("8:800");
    expect(found!.identity).toContain("9:900");
  });

  it.each([
    ["a sibling shell", [...outerRows, { ...outerRows.find((row) => row.pid === 9)!, pid: 12 }]],
    ["a foreign client parent", outerRows.map((row) => row.pid === 10 ? { ...row, parent: 99 } : row)],
    ["a missing shell", outerRows.filter((row) => row.pid !== 9)],
    ["a non-shell intermediary", outerRows.map((row) => row.pid === 9 ? { ...row, command: "node" } : row)],
    ["a cycle", outerRows.map((row) => row.pid === 9 ? { ...row, parent: 10 } : row)],
    ["another tty", outerRows.map((row) => row.pid === 9 ? { ...row, tty: "pts/8" } : row)],
    ["a background shell", outerRows.map((row) => row.pid === 9 ? { ...row, group: 99 } : row)],
  ])("refuses outer ancestry with %s", async (_name, rows) => {
    expect(await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => rows as TerminalProcess[], births)).toBeNull();
  });

  it.each([8, 9])("refuses missing/reused outer shell birth %s", async (changed) => {
    expect(await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows,
      (pid) => pid === changed ? null : births(pid))).toBeNull();
    let reads = 0;
    expect(await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows,
      (pid) => births(pid) + (pid === changed && ++reads > 1 ? 1 : 0))).toBeNull();
  });

  it("includes outer shell births in the binding across requests", async () => {
    let generation = 0;
    const read = () => tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows,
      (pid) => births(pid) + (pid === 9 ? generation : 0));
    const first = await read(); generation++;
    const second = await read();
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(second!.identity).not.toBe(first!.identity);
  });

  it("refuses an outer shell reparented between observations", async () => {
    let reads = 0;
    expect(await tmuxCodexProcess(outerInfo, "linux", async () => mapping,
      async () => ++reads === 1 ? outerRows : outerRows.map((row) => row.pid === 9 ? { ...row, parent: 1 } : row), births)).toBeNull();
  });

  it("rejects stale reported membership, a missing root and multiple clients", async () => {
    for (const value of [
      { ...outerInfo, shell_pid: 99 },
      { ...outerInfo, foreground_processes: outerInfo.foreground_processes!.slice(1) },
      { ...outerInfo, foreground_processes: [...outerInfo.foreground_processes!, outerInfo.foreground_processes![0]!] },
      { ...outerInfo, foreground_processes: [...outerInfo.foreground_processes!, { pid: 12, argv: ["tmux", "attach"] }] },
    ]) expect(await tmuxCodexProcess(value as ProcessInfo, "linux", async () => mapping, async () => outerRows, births)).toBeNull();
    expect(tmuxWrapper({ ...outerInfo, foreground_processes: [...outerInfo.foreground_processes!, { pid: 12, argv: ["tmux", "attach"] }] } as ProcessInfo)).toBe(true);
  });

  const snapshot = (state: string, changed = 40, live = "S+") => parseTerminalProcesses([...wrapped,
    { pid: 40, parent: 30, group: 25, foreground: 25, tty: "pts/2", command: "chrome" },
  ].map((row) => `${row.pid} ${row.parent} ${row.group} ${row.foreground} ${row.tty} ${row.pid === changed ? state : live} ${row.command}`).join("\n"));

  it("ignores a zombie foreground peer while keeping live-state changes out of binding identity", async () => {
    let reads = 0;
    const found = await tmuxCodexProcess(info, "linux", async () => mapping,
      async () => ++reads === 1 ? snapshot("Z") : snapshot("Z+", 40, "R+"), births);
    expect(found).toMatchObject({ pid: 30, argv: ["/opt/bin/codex"] });
    expect(parseTerminalProcesses("30 25 25 25 pts/2 S+ /opt/bin/codex"))
      .toEqual(parseTerminalProcesses("30 25 25 25 pts/2 R+ /opt/bin/codex"));
  });

  it.each(["S", "R", "S+"])("still refuses a live %s foreground peer", async (state) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => snapshot(state), births)).toBeNull();
  });

  it.each([10, 20, 25, 30])("refuses zombie client/root/launcher/Codex PID %s", async (pid) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping,
      async () => snapshot("Z", pid).filter((row) => row.pid !== 40), births)).toBeNull();
  });

  it("accepts one foreground Codex through its pane root's foreground shell launcher", async () => {
    const found = await tmuxCodexProcess(info, "linux", async () => mapping, async () => wrapped, births);
    expect(found).toMatchObject({ pid: 30, argv: ["/opt/bin/codex"] });
    expect(found!.identity).toContain("25:2500");
  });

  it.each([
    ["an unrelated foreground shell", [...wrapped, { ...wrapped.at(-1)!, pid: 40 }]],
    ["two native Codex processes", [...wrapped, { ...wrapped.find((row) => row.pid === 30)!, pid: 31 }]],
    ["a missing shell ancestor", wrapped.filter((row) => row.pid !== 25)],
    ["a cyclic parent chain", wrapped.map((row) => row.pid === 25 ? { ...row, parent: 30 } : row)],
    ["a foreign shell ancestor", wrapped.map((row) => row.pid === 25 ? { ...row, parent: 99 } : row)],
    ["a non-shell launcher", wrapped.map((row) => row.pid === 25 ? { ...row, command: "/bin/node" } : row)],
    ["a background launcher", wrapped.map((row) => row.pid === 25 ? { ...row, group: 99 } : row)],
    ["a launcher on another tty", wrapped.map((row) => row.pid === 25 ? { ...row, tty: "pts/9" } : row)],
  ])("refuses wrapper ancestry with %s", async (_name, rows) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows as TerminalProcess[], births)).toBeNull();
  });

  it.each(["exit", "reparent", "reuse"])("refuses wrapper %s during verification", async (change) => {
    let reads = 0, wrapperBirths = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => { reads++; return mapping; },
      async () => reads < 2 || change === "reuse" ? wrapped : change === "exit" ? wrapped.filter((row) => row.pid !== 25)
        : wrapped.map((row) => row.pid === 25 ? { ...row, parent: 99 } : row),
      (pid) => births(pid) + (change === "reuse" && pid === 25 && ++wrapperBirths > 1 ? 1 : 0))).toBeNull();
  });

  it("changes the binding identity when a shell wrapper's birth changes between lookups", async () => {
    let generation = 0;
    const read = () => tmuxCodexProcess(info, "linux", async () => mapping, async () => wrapped,
      (pid) => births(pid) + (pid === 25 ? generation : 0));
    const before = await read();
    generation++;
    const after = await read();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!.identity).not.toBe(before!.identity);
  });

  it("follows the exact client's current pane, not its attach command's old target", async () => {
    const args: string[][] = [];
    const found = await tmuxCodexProcess(info, "linux", async (input) => { args.push(input); return mapping; }, async () => processes, births);
    expect(found).toMatchObject({ pid: 30, argv: ["/opt/bin/codex"] });
    expect(args).toEqual([["-S", "/fixture/tmux.sock"], ["-S", "/fixture/tmux.sock"]]);
    expect(found!.identity).toContain("$2:@3:%4");
  });

  it.each([
    ["wrong client", mapping.replace(/^10\t/, "12\t")],
    ["wrong outer tty", mapping.replace("/dev/pts/1", "/dev/pts/8")],
    ["wrong socket", mapping.replace("/fixture/tmux.sock", "/other/tmux.sock")],
    ["duplicate client", mapping + mapping],
    ["control client", mapping.replace(/\t0\t0\n$/, "\t1\t0\n")],
    ["dead pane with reused PID and tty", mapping.replace(/\t0\n$/, "\t1\n")],
    ["missing pane liveness", mapping.replace(/\t0\n$/, "\n")],
    ["incomplete mapping", "10\t/dev/pts/1\n"],
  ])("rejects %s", async (_name, value) => {
    expect(await tmuxCodexProcess(info, "linux", async () => value, async () => processes, births)).toBeNull();
  });

  it.each(["%4", "@3", "$2", "/dev/pts/2"])("rejects a switched %s between reads", async (value) => {
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => ++reads === 1 ? mapping : mapping.replace(value, value + "9"), async () => processes, births)).toBeNull();
  });

  it.each(["dead", "reparented"])("rejects a pane that becomes %s between reads", async (change) => {
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux",
      async () => ++reads > 1 && change === "dead" ? mapping.replace(/\t0\n$/, "\t1\n") : mapping,
      async () => reads > 1 && change === "reparented" ? processes.map((row) => row.pid === 20 ? { ...row, parent: 99 } : row) : processes,
      births)).toBeNull();
  });

  it.each([10, 11, 20, 30])("rejects PID %s reuse", async (reused) => {
    let count = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes,
      (pid) => births(pid) + (pid === reused && ++count > 1 ? 1 : 0))).toBeNull();
  });

  it.each([
    ["client no longer foreground", processes.map((row) => row.pid === 10 ? { ...row, foreground: 99 } : row)],
    ["wrong pane root", processes.filter((row) => row.pid !== 20)],
    ["pane root owned by another server", processes.map((row) => row.pid === 20 ? { ...row, parent: 99 } : row)],
    ["unrelated Codex", processes.map((row) => row.pid === 30 ? { ...row, parent: 99 } : row)],
    ["another foreground process", [...processes, { ...processes[3]!, pid: 31 }]],
    ["a shell only", processes.map((row) => row.pid === 30 ? { ...row, command: "/bin/bash" } : row)],
    ["wrong inner tty", processes.map((row) => row.pid === 30 ? { ...row, tty: "pts/9" } : row)],
  ])("rejects %s", async (_name, rows) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows as TerminalProcess[], births)).toBeNull();
  });

  it("refuses inaccessible lookups and unknown births", async () => {
    expect(await tmuxCodexProcess(info, "linux", async () => { throw new Error("denied"); }, async () => processes, births)).toBeNull();
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, () => null)).toBeNull();
  });

  it("does not probe a direct Codex, Kiro wrapper, control-mode command or unsupported platform", async () => {
    const read = async () => { throw new Error("must not probe"); };
    for (const argv of [["codex"], ["zsh (kiro-cli-term)"], ["tmux", "-C", "attach"], ["tmux", "-S", "relative.sock", "attach"]]) {
      const other = { foreground_processes: [{ pid: 10, argv }] } as ProcessInfo;
      expect(tmuxWrapper(other)).toBe(false);
      expect(await tmuxCodexProcess(other, "linux", read)).toBeNull();
    }
    expect(await tmuxCodexProcess(info, "win32", read)).toBeNull();
  });
});
