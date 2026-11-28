import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPrimeDaemon, primeTranscriptPath, type PrimeDaemonList, type PrimeReaders } from "./prime.ts";
import { transcriptPage } from "./conversation.ts";

const DAEMON = "/run/user/1000/prime-agent-1000/daemon.sock";
const STORE = "/home/me/.prime/agent/sessions";
const tui = [{ pid: 100, name: "prime-agent", argv: ["prime-agent"] }];
const session = (n: number, workerPid: number | null) => ({ activeSessionId: `a${n}`, sessionId: `s${n}`, sessionFile: `${STORE}/s${n}.jsonl`, workerPid });

/** pid 100 is the pane's TUI on the daemon (supervisor 200) and on the worker of session 1 (pid 300); worker 301 runs session 2. */
function machine(overrides: Partial<PrimeReaders> & { lists?: (PrimeDaemonList | null)[] } = {}): PrimeReaders {
  const fds: Record<number, string[]> = { 100: ["socket:[1]", "socket:[2]", "/dev/pts/3"], 200: ["socket:[11]"], 300: ["socket:[12]"], 301: ["socket:[13]"] };
  const lists = overrides.lists ?? [{ supervisorPid: 200, sessions: [session(1, 300), session(2, 301)] }];
  let asked = 0;
  return {
    platform: "linux",
    descriptors: (pid) => fds[pid] ? new Map(fds[pid].map((target, fd) => [String(fd), target])) : null,
    started: () => 4242,
    argv: (pid) => pid === 200 ? ["/opt/prime/prime-agent", "--mode", "daemon", "--daemon-socket", DAEMON] : pid === 300 || pid === 301 ? ["/opt/prime/prime-agent", "worker"] : ["prime-agent"],
    sockets: async () => ({ peers: new Map([["1", "11"], ["2", "12"]]), names: new Map([["11", DAEMON], ["12", "/run/user/1000/prime-agent-1000/worker-ab12-cd34.sock"], ["13", "/run/user/1000/prime-agent-1000/worker-ab12-ef56.sock"]]) }),
    list: async () => lists[Math.min(asked++, lists.length - 1)] ?? null,
    header: (path) => ({ id: path.slice(STORE.length + 1, -".jsonl".length), identity: `9:${path.length}` }),
    ...overrides,
  };
}

describe("the Prime Agent session a pane shows", () => {
  it("is the one whose worker the pane's TUI is linked to, as the daemon the TUI is on names it", async () => {
    expect(await primeTranscriptPath("p1", { processes: tui, readers: machine() }))
      .toEqual({ path: `${STORE}/s1.jsonl`, identity: `9:${`${STORE}/s1.jsonl`.length}`, agentDir: "/home/me/.prime/agent" });
  });

  it("follows the link to another worker, as after /resume in a second pane of the same folder", async () => {
    const readers = machine({ sockets: async () => ({ peers: new Map([["1", "11"], ["2", "13"]]), names: new Map([["11", DAEMON], ["13", "/run/user/1000/prime-agent-1000/worker-ab12-ef56.sock"]]) }) });
    expect((await primeTranscriptPath("p2", { processes: tui, readers }))?.path).toBe(`${STORE}/s2.jsonl`);
  });

  it("proves nothing while the TUI is linked to no worker (its agents view) or to two", async () => {
    const view = machine({ sockets: async () => ({ peers: new Map([["1", "11"]]), names: new Map([["11", DAEMON]]) }) });
    expect(await primeTranscriptPath("p1", { processes: tui, readers: view })).toBeNull();
    // both workers own one end of the TUI's streams
    const both = machine({ descriptors: (pid) => new Map(pid === 100 ? [["0", "socket:[1]"], ["1", "socket:[2]"]] : [["0", pid === 200 ? "socket:[11]" : "socket:[12]"]]) });
    expect(await primeTranscriptPath("p1", { processes: tui, readers: both })).toBeNull();
    expect((await primeTranscriptPath("p1", { processes: tui, readers: machine({ descriptors: both.descriptors, lists: [{ supervisorPid: 200, sessions: [session(1, 300)] }] }) }))?.path).toBe(`${STORE}/s1.jsonl`);
  });

  it("proves nothing when the daemon that answers is not the one the TUI is on, or the TUI is on two", async () => {
    expect(await primeTranscriptPath("p1", { processes: tui, readers: machine({ lists: [{ supervisorPid: 301, sessions: [session(1, 300)] }] }) })).toBeNull();
    const two = machine({ sockets: async () => ({ peers: new Map([["1", "11"], ["2", "12"], ["3", "14"]]), names: new Map([["11", DAEMON], ["12", "/run/user/1000/prime-agent-1000/worker-ab12-cd34.sock"], ["14", "/tmp/other/daemon.sock"]]) }),
      descriptors: (pid) => pid === 100 ? new Map([["0", "socket:[1]"], ["1", "socket:[2]"], ["2", "socket:[3]"]]) : machine().descriptors(pid) });
    expect(await primeTranscriptPath("p1", { processes: tui, readers: two })).toBeNull();
  });

  it("proves nothing when the file names another session, or the session or the TUI changed while it was read", async () => {
    expect(await primeTranscriptPath("p1", { processes: tui, readers: machine({ header: () => ({ id: "s9", identity: "9:1" }) }) })).toBeNull();
    const moved = machine({ lists: [{ supervisorPid: 200, sessions: [session(1, 300)] }, { supervisorPid: 200, sessions: [session(1, 301)] }] });
    expect(await primeTranscriptPath("p1", { processes: tui, readers: moved })).toBeNull();
    let birth = 1;
    expect(await primeTranscriptPath("p1", { processes: tui, readers: machine({ started: () => birth++ }) })).toBeNull();
    for (const changed of [100, 200, 300]) {
      let reads = 0;
      expect(await primeTranscriptPath("p1", { processes: tui, readers: machine({ started: (pid) => pid === changed && reads++ > 0 ? 9 : 4242 }) })).toBeNull();
    }
    let descriptorReads = 0;
    const replaced = machine({ descriptors: (pid) => pid === 100 && descriptorReads++ > 0 ? new Map([["0", "socket:[1]"], ["1", "socket:[99]"]]) : machine().descriptors(pid) });
    expect(await primeTranscriptPath("p1", { processes: tui, readers: replaced })).toBeNull();
  });

  it("takes no process in another role for the daemon or a worker", async () => {
    expect(await primeTranscriptPath("p1", { processes: tui, readers: machine({ argv: (pid) => pid === 300 ? ["/opt/prime/prime-agent"] : machine().argv(pid) }) })).toBeNull();
    expect(await primeTranscriptPath("p1", { processes: tui, readers: machine({ argv: (pid) => pid === 200 ? ["/usr/bin/socat", "daemon"] : machine().argv(pid) }) })).toBeNull();
  });

  it("proves nothing off Linux, for a session without a file, or for a pane with two Prime Agent TUIs", async () => {
    expect(await primeTranscriptPath("p1", { processes: tui, readers: machine({ platform: "darwin" }) })).toBeNull();
    expect(await primeTranscriptPath("p1", { processes: tui, readers: machine({ lists: [{ supervisorPid: 200, sessions: [{ ...session(1, 300), sessionFile: null }] }] }) })).toBeNull();
    expect(await primeTranscriptPath("p1", { processes: [...tui, { pid: 101, name: "prime-agent", argv: ["prime-agent", "attach", "x"] }], readers: machine() })).toBeNull();
  });
});

describe("asking Prime Agent's daemon for its live sessions", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  async function daemon(answer: (command: Record<string, any>) => object, name = "prime-agent.daemon") {
    dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pa-"));
    const socket = join(dir, "daemon.sock");
    const commands: Record<string, any>[] = [];
    let received = "";
    const server = Bun.listen({ unix: socket, socket: {
      open(client) { client.write(`${JSON.stringify({ type: "daemon_hello", supervisorPid: 4321, protocol: { name, version: 7 } })}\n`); },
      data(client, chunk) {
        received += chunk.toString();
        const lines = received.split("\n");
        received = lines.pop()!;
        for (const line of lines.filter(Boolean)) {
          const command = JSON.parse(line) as Record<string, any>;
          commands.push(command);
          client.write(`${JSON.stringify(answer(command))}\n`);
        }
      },
    } });
    return { socket, commands, server };
  }

  it("asks `list` under the daemon's own protocol and an id of Ovis's, and reads each session's worker and file", async () => {
    const { socket, commands, server } = await daemon((command) => ({ type: "response", id: command.id, success: true,
      data: { sessions: [{ activeSessionId: "a1", sessionId: "s1", sessionFile: "/s1.jsonl", workerPid: 77, attachedClients: 1 }, { activeSessionId: "a2" }] } }));
    try {
      expect(await listPrimeDaemon(socket)).toEqual({ supervisorPid: 4321, sessions: [{ activeSessionId: "a1", sessionId: "s1", sessionFile: "/s1.jsonl", workerPid: 77 }] });
      expect(commands).toEqual([{ type: "command", id: expect.stringMatching(/^ovis-[0-9a-f]{12}$/), protocol: { name: "prime-agent.daemon", version: 7 }, clientId: commands[0]!.id, command: { type: "list", id: commands[0]!.id } }]);
    } finally { server.stop(true); }
  });

  it("asks nothing of a socket that is not Prime Agent's daemon, and takes no failed answer", async () => {
    const other = await daemon(() => ({}), "another.daemon");
    try {
      expect(await listPrimeDaemon(other.socket)).toBeNull();
      expect(other.commands).toEqual([]);
    } finally { other.server.stop(true); rmSync(dir!, { recursive: true, force: true }); }
    const failed = await daemon((command) => ({ type: "response", id: command.id, success: false, error: "no" }));
    try { expect(await listPrimeDaemon(failed.socket)).toBeNull(); } finally { failed.server.stop(true); rmSync(dir!, { recursive: true, force: true }); }
  });

  it("skips malformed frames and rows instead of failing on them", async () => {
    const { socket, server } = await daemon((command) => ({ type: "response", id: command.id, success: true, data: { sessions: [null, 7, { activeSessionId: "a1", sessionId: "s1", workerPid: 5 }] } }));
    try {
      expect(await listPrimeDaemon(socket)).toEqual({ supervisorPid: 4321, sessions: [{ activeSessionId: "a1", sessionId: "s1", sessionFile: null, workerPid: 5 }] });
    } finally { server.stop(true); }
  });
});

describe("a Prime Agent session read as pi's", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("shows the prompt, the Python cell and the answer of a recorded 0.10.5 session, and never its harness digest", () => {
    dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pa-"));
    const path = join(dir, "session.jsonl");
    const recorded = readFileSync(join(import.meta.dir, "fixtures", "prime-agent-0.10.5-session.jsonl"), "utf8");
    const leaf = (JSON.parse(recorded.trim().split("\n").at(-1)!) as { id: string }).id;
    // a digest shown as a notice would put the model's own notes in the chat
    const digest = { type: "custom_message", id: "d1", parentId: leaf, timestamp: "2026-11-28T03:20:00.000Z", customType: "harness_digest", content: "harness notes", display: true };
    writeFileSync(path, `${recorded}${JSON.stringify(digest)}\n`);
    const page = transcriptPage("pi-transcript", path, { prompts: 5 });
    const parts = page.turns.flatMap((turn) => turn.parts);
    expect(parts[0]).toMatchObject({ kind: "text", text: expect.stringContaining("Create a file named hello.txt") });
    expect(parts.some((part) => part.kind === "tool" && part.name === "python_repl")).toBe(true);
    expect(JSON.stringify(parts)).toContain("DONE");
    expect(JSON.stringify(parts)).not.toContain("harness notes");
  });
});
