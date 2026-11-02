import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiVoiceHub, type PiVoiceSocket, type PiVoiceSocketData, withPiVoiceSockets } from "./pi-voice.ts";
import { piVoiceSocketCandidates } from "./pi.ts";

const PANE = "w2W:p1";
let root: string;
const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ovis-pi-voice-")); });
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
  rmSync(root, { recursive: true, force: true });
});

/** Bounded wait for what a socket will do. */
async function until(done: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!done() && Date.now() < deadline) await Bun.sleep(5);
  if (!done()) throw new Error(`timed out waiting for ${label}`);
}

type FakePi = { path: string; received: object[]; closed: () => boolean; send: (frame: object) => void; end: () => void };

/** A Pi's bridge socket at `<agentDir>/live-bridge/<pid>.sock`, saying `ready` as the real one does. */
async function fakePi(agentDir: string, pid: number, ready: object | null = { type: "ready", pid, pane: PANE, busy: false }): Promise<FakePi> {
  const directory = join(agentDir, "live-bridge");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${pid}.sock`);
  const received: object[] = [];
  let connection: net.Socket | undefined;
  let closed = false;
  const server = net.createServer((socket) => {
    connection = socket;
    sockets.push(socket);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
        received.push(JSON.parse(buffered.slice(0, end)) as object);
        buffered = buffered.slice(end + 1);
      }
    });
    socket.on("close", () => { closed = true; });
    socket.on("error", () => {});
    if (ready) socket.write(`${JSON.stringify({ v: 1, ...ready })}\n`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    received,
    closed: () => closed,
    send: (frame) => { connection?.write(`${JSON.stringify({ v: 1, ...frame })}\n`); },
    end: () => connection?.end(),
  };
}

type FakePhone = PiVoiceSocket & { sent: Array<Record<string, unknown>>; closed: boolean; pings: number };
function fakePhone(paneId = PANE): FakePhone {
  const phone: FakePhone = {
    data: { piVoice: { paneId, deviceId: undefined } },
    sent: [],
    closed: false,
    pings: 0,
    send(text) { phone.sent.push(JSON.parse(text) as Record<string, unknown>); },
    close() { phone.closed = true; },
    ping() { phone.pings += 1; },
  };
  return phone;
}

const frame = (body: object) => JSON.stringify({ v: 1, ...body });

/** The relay's clock and heartbeat timer, moved by hand. */
function manualClock() {
  let now = 0;
  const timers = new Set<{ run: () => void; every: number; next: number }>();
  return {
    now: () => now,
    every(run: () => void, every: number) {
      const timer = { run, every, next: now + every };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((timer) => timer.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.every;
        due.run();
      }
      now = end;
    },
  };
}

describe("piVoiceSocketCandidates", () => {
  const pi = (pid: number) => ({ pid, argv: ["pi"], cwd: "/work" });
  const options = (extra: object) => ({ agent: { agent: "pi" } as never, home: "/home/user", ...extra });

  it("finds a Pi's socket under the agent directory its own environment names", async () => {
    const agentDir = join(root, "custom-agent");
    await fakePi(agentDir, 4242);
    const found = await piVoiceSocketCandidates(PANE, options({
      processes: [pi(4242)],
      environOf: () => ["HOME=/home/user", `PI_CODING_AGENT_DIR=${agentDir}`],
    }));
    expect(found).toEqual([{ pid: 4242, path: join(agentDir, "live-bridge", "4242.sock") }]);
  });

  it("falls back to the process's own HOME, expands a tilde and resolves a relative directory from its cwd", async () => {
    const home = join(root, "home");
    await fakePi(join(home, ".pi", "agent"), 11);
    await fakePi(join(home, "tilde-agent"), 12);
    await fakePi(join(root, "work", "relative-agent"), 13);
    const environs: Record<number, string[]> = {
      11: [`HOME=${home}`],
      12: [`HOME=${home}`, "PI_CODING_AGENT_DIR=~/tilde-agent"],
      13: [`HOME=${home}`, "PI_CODING_AGENT_DIR=relative-agent"],
    };
    const found = await piVoiceSocketCandidates(PANE, options({
      processes: [pi(11), pi(12), { pid: 13, argv: ["pi"], cwd: join(root, "work") }],
      environOf: (pid: number) => environs[pid] ?? null,
    }));
    expect(found?.map((candidate) => candidate.pid)).toEqual([11, 12, 13]);
  });

  it("tries every foreground process, since a wrapper may sit in front of Pi", async () => {
    const agentDir = join(root, "agent");
    await fakePi(agentDir, 22);
    const found = await piVoiceSocketCandidates(PANE, options({
      processes: [{ pid: 21, argv: ["/usr/bin/env", "pi"], cwd: "/work" }, pi(22)],
      environOf: () => [`PI_CODING_AGENT_DIR=${agentDir}`],
    }));
    expect(found?.map((candidate) => candidate.pid)).toEqual([22]);
  });

  it("uses the server's own agent directory where the environment cannot be read", async () => {
    const agentDir = join(root, "server-agent");
    await fakePi(agentDir, 31);
    const found = await piVoiceSocketCandidates(PANE, options({ processes: [pi(31)], environOf: () => null, agentDir }));
    expect(found?.map((candidate) => candidate.pid)).toEqual([31]);
  });

  it("gives nothing for a pane that is not Pi, and no socket for a Pi without the bridge", async () => {
    const agentDir = join(root, "agent");
    await fakePi(agentDir, 41);
    const base = { processes: [pi(41)], environOf: () => [`PI_CODING_AGENT_DIR=${agentDir}`] };
    expect(await piVoiceSocketCandidates(PANE, { ...base, agent: { agent: "claude" } as never, home: "/h" })).toBeNull();
    expect(await piVoiceSocketCandidates(PANE, options({ ...base, processes: [pi(42)] }))).toEqual([]);
  });

  it("keeps only sockets: a regular file or a link at the path is no bridge", async () => {
    const agentDir = join(root, "agent");
    const directory = join(agentDir, "live-bridge");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "51.sock"), "");
    const real = await fakePi(join(root, "elsewhere"), 52);
    symlinkSync(real.path, join(directory, "52.sock"));
    const found = await piVoiceSocketCandidates(PANE, options({
      processes: [pi(51), pi(52)],
      environOf: () => [`PI_CODING_AGENT_DIR=${agentDir}`],
    }));
    expect(found).toEqual([]);
  });
});

describe("the relay between a phone and a Pi", () => {
  function hubFor(candidates: Array<{ pid: number; path: string }> | null, extra: object = {}) {
    const clock = manualClock();
    const revokes: Array<() => void> = [];
    const hub = new PiVoiceHub({
      candidates: async () => candidates,
      onRevoke: (_id, close) => { revokes.push(close); return () => {}; },
      every: clock.every,
      now: clock.now,
      ...extra,
    });
    return { hub, clock, revokes };
  }

  async function connected(agentDir = join(root, "agent")) {
    const pi = await fakePi(agentDir, 77);
    const harness = hubFor([{ pid: 77, path: pi.path }]);
    const phone = fakePhone();
    await harness.hub.open(phone);
    return { ...harness, pi, phone };
  }

  it("sends start only after Pi's ready, then the frames the phone sent meanwhile", async () => {
    const pi = await fakePi(join(root, "agent"), 77);
    const { hub } = hubFor([{ pid: 77, path: pi.path }]);
    const phone = fakePhone();
    const opening = hub.open(phone);
    hub.message(phone, frame({ type: "hello" }));
    await opening;
    await until(() => pi.received.length >= 2, "start and hello");
    expect(pi.received).toEqual([{ v: 1, type: "start" }, { v: 1, type: "hello" }]);
  });

  it("starts the call in the voice the phone chose", async () => {
    const pi = await fakePi(join(root, "agent"), 77);
    const { hub } = hubFor([{ pid: 77, path: pi.path }]);
    const phone = fakePhone();
    phone.data.piVoice.voice = "vale";
    await hub.open(phone);
    await until(() => pi.received.length >= 1, "start");
    expect(pi.received[0]).toEqual({ v: 1, type: "start", voice: "vale" });
  });

  it("passes Pi's frames to the phone and the phone's answers to Pi", async () => {
    const { hub, pi, phone } = await connected();
    pi.send({ type: "request", id: 1, method: "open" });
    pi.send({ type: "phase", phase: "listening" });
    pi.send({ type: "transcript", role: "user", text: "hello", turn: 1, final: false });
    await until(() => phone.sent.length === 3, "three frames");
    expect(phone.sent.map((sent) => sent["type"])).toEqual(["request", "phase", "transcript"]);
    hub.message(phone, frame({ type: "response", id: 1, ok: true }));
    hub.message(phone, frame({ type: "levels", input: 0.5, output: 0 }));
    hub.message(phone, frame({ type: "set-muted", muted: true }));
    await until(() => pi.received.length === 4, "answers");
    expect(pi.received.slice(1).map((sent) => (sent as { type: string }).type)).toEqual(["response", "levels", "set-muted"]);
  });

  it("forwards only what it validated, re-serialized, never the phone's raw text", async () => {
    const { hub, pi, phone } = await connected();
    hub.message(phone, '{"v":1,\n"type":"stop"}');
    await until(() => pi.received.length === 2, "stop");
    expect(pi.received[1]).toEqual({ v: 1, type: "stop" });
    expect(phone.closed).toBe(false);
  });

  it("passes Pi's park, its parked phase and the call's billed seconds, and tells Pi the phone's features and resume", async () => {
    const { hub, pi, phone } = await connected();
    pi.send({ type: "park" });
    pi.send({ type: "phase", phase: "parked" });
    pi.send({ type: "usage", seconds: 75 });
    await until(() => phone.sent.length === 3, "three frames");
    expect(phone.sent).toEqual([{ v: 1, type: "park" }, { v: 1, type: "phase", phase: "parked" }, { v: 1, type: "usage", seconds: 75 }]);
    hub.message(phone, frame({ type: "hello", features: ["park", "usage"] }));
    hub.message(phone, frame({ type: "resume" }));
    await until(() => pi.received.length === 3, "hello and resume");
    expect(pi.received.slice(1)).toEqual([{ v: 1, type: "hello", features: ["park", "usage"] }, { v: 1, type: "resume" }]);
    expect(phone.closed).toBe(false);
  });

  it("closes both ends on a phone frame outside its allowlist", async () => {
    for (const bad of [
      frame({ type: "start" }),
      frame({ type: "request", id: 1, method: "open" }),
      frame({ type: "hello", token: "secret" }),
      frame({ type: "hello", features: "park" }),
      frame({ type: "hello", features: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
      frame({ type: "hello", features: ["x".repeat(33)] }),
      frame({ type: "hello", features: [1] }),
      frame({ type: "resume", now: true }),
      frame({ type: "levels", input: 2, output: 0 }),
      "not json",
    ]) {
      const { hub, pi, phone } = await connected(join(root, `agent-${Math.random()}`));
      hub.message(phone, bad);
      await until(() => pi.closed(), `Pi closed after ${bad.slice(0, 24)}`);
      expect(phone.closed).toBe(true);
    }
  });

  it("closes both ends, and tells the phone, on a Pi frame outside its allowlist", async () => {
    for (const bad of [{ type: "ready", pid: 77, busy: false }, { type: "secret" }, { type: "phase", phase: "dancing" }, { type: "usage", seconds: -1 }, { type: "usage", seconds: 1.5 }, { type: "usage" }, { type: "park", now: true }]) {
      const { pi, phone } = await connected(join(root, `agent-${Math.random()}`));
      pi.send(bad);
      await until(() => phone.closed, "phone closed");
      expect(phone.sent.at(-1)).toEqual({ v: 1, type: "ended", code: "closed" });
      await until(() => pi.closed(), "Pi closed");
    }
  });

  it("passes Pi's ended on and closes both ends", async () => {
    const { pi, phone } = await connected();
    pi.send({ type: "ended", error: "Live voice is disabled." });
    await until(() => phone.closed, "phone closed");
    expect(phone.sent.at(-1)).toEqual({ v: 1, type: "ended", error: "Live voice is disabled." });
    await until(() => pi.closed(), "Pi closed");
  });

  it("ends the phone when Pi goes away, and Pi when the phone does", async () => {
    const first = await connected();
    first.pi.end();
    await until(() => first.phone.closed, "phone closed");
    expect(first.phone.sent.at(-1)).toEqual({ v: 1, type: "ended", code: "closed" });

    const second = await connected(join(root, "second"));
    second.hub.close(second.phone);
    await until(() => second.pi.closed(), "Pi closed");
  });

  it("allows one call per pane, and the pane again once it ends", async () => {
    const { hub, phone, pi } = await connected();
    const second = fakePhone();
    await hub.open(second);
    expect(second.sent).toEqual([{ v: 1, type: "ended", code: "busy" }]);
    expect(second.closed).toBe(true);
    hub.close(phone);
    await until(() => pi.closed(), "first call over");
    const third = fakePhone();
    await hub.open(third);
    expect(third.sent.some((sent) => sent["code"] === "busy")).toBe(false);
  });

  it("says why it cannot connect: not Pi, no bridge, Pi busy, or a Pi that is someone else", async () => {
    const outcome = async (candidates: Array<{ pid: number; path: string }> | null) => {
      const phone = fakePhone();
      await hubFor(candidates).hub.open(phone);
      return [phone.sent.at(-1)?.["code"], phone.closed];
    };
    expect(await outcome(null)).toEqual(["not_pi", true]);
    expect(await outcome([])).toEqual(["unavailable", true]);
    const busy = await fakePi(join(root, "busy"), 61, { type: "ready", pid: 61, pane: PANE, busy: true });
    expect(await outcome([{ pid: 61, path: busy.path }])).toEqual(["busy", true]);
    const otherPid = await fakePi(join(root, "pid"), 62, { type: "ready", pid: 999, pane: PANE, busy: false });
    expect(await outcome([{ pid: 62, path: otherPid.path }])).toEqual(["unavailable", true]);
    const otherPane = await fakePi(join(root, "pane"), 63, { type: "ready", pid: 63, pane: "w9:p9", busy: false });
    expect(await outcome([{ pid: 63, path: otherPane.path }])).toEqual(["unavailable", true]);
    const silent = await fakePi(join(root, "silent"), 64, null);
    const phone = fakePhone();
    await hubFor([{ pid: 64, path: silent.path }], { readyMs: 50 }).hub.open(phone);
    expect(phone.sent.at(-1)?.["code"]).toBe("unavailable");
  });

  it("pings the phone and ends the call once it has been silent for the lease", async () => {
    const { clock, pi, phone, hub } = await connected();
    clock.advance(5_000);
    expect(phone.pings).toBe(1);
    hub.pong(phone);
    clock.advance(15_000);
    expect(phone.closed).toBe(false);
    hub.message(phone, frame({ type: "levels", input: 0, output: 0 }));
    clock.advance(19_000);
    expect(phone.closed).toBe(false);
    clock.advance(6_000);
    expect(phone.closed).toBe(true);
    await until(() => pi.closed(), "Pi closed");
  });

  it("ends the call when the phone's device is revoked", async () => {
    const pi = await fakePi(join(root, "agent"), 77);
    const { hub, revokes } = hubFor([{ pid: 77, path: pi.path }]);
    const phone = fakePhone();
    phone.data.piVoice.deviceId = "device-1";
    await hub.open(phone);
    expect(revokes).toHaveLength(1);
    revokes[0]!();
    expect(phone.closed).toBe(true);
    // a real socket reports its own close; the fake is told
    hub.close(phone);
    await until(() => pi.closed(), "Pi closed");
  });
});

describe("a call with the Pi of a pane on another PC", () => {
  const bridges: Array<{ stop(force?: boolean): unknown }> = [];
  afterEach(() => { for (const bridge of bridges.splice(0)) bridge.stop(true); });

  /** That PC's bridge: its own hub behind /ws/pi-voice, for this token only. */
  function remoteBridge(candidates: Array<{ pid: number; path: string }> | null) {
    const hub = new PiVoiceHub({ candidates: async () => candidates });
    const bridge = Bun.serve<PiVoiceSocketData>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        const url = new URL(request.url);
        if (request.headers.get("authorization") !== "Bearer pc-token" || url.pathname !== "/ws/pi-voice") return new Response("no", { status: 404 });
        const voice = url.searchParams.get("voice");
        const data = { piVoice: { paneId: url.searchParams.get("pane_id")!, deviceId: undefined, ...(voice ? { voice: voice as "vale" } : {}) } };
        return server.upgrade(request, { data }) ? undefined : new Response("upgrade", { status: 426 });
      },
      websocket: withPiVoiceSockets({ message() {} }, hub),
    });
    bridges.push(bridge);
    return `http://127.0.0.1:${bridge.port}`;
  }

  function phoneOn(url: string, token = "pc-token") {
    const tracked: Array<() => void> = [];
    const phone = fakePhone();
    phone.data.piVoice.machine = { endpoint: { url, token }, track: (close) => { tracked.push(close); return () => {}; } };
    return { phone, tracked };
  }

  it("reaches that PC's Pi through its bridge, both ways", async () => {
    const pi = await fakePi(join(root, "agent"), 77);
    const url = remoteBridge([{ pid: 77, path: pi.path }]);
    const hub = new PiVoiceHub({ candidates: async () => { throw new Error("this PC's Pi is not asked"); } });
    const { phone } = phoneOn(url);
    phone.data.piVoice.voice = "vale";
    await hub.open(phone);
    hub.message(phone, frame({ type: "hello" }));
    await until(() => pi.received.length >= 2, "start and hello on the other PC");
    expect(pi.received).toEqual([{ v: 1, type: "start", voice: "vale" }, { v: 1, type: "hello" }]);
    pi.send({ type: "phase", phase: "listening" });
    await until(() => phone.sent.length === 1, "Pi's frame");
    expect(phone.sent[0]).toEqual({ v: 1, type: "phase", phase: "listening" });
    hub.close(phone);
    await until(() => pi.closed(), "Pi closed");
  });

  it("says a PC whose bridge has no voice is unavailable", async () => {
    const url = remoteBridge(null);
    const { phone } = phoneOn(url, "wrong-token");
    await new PiVoiceHub().open(phone);
    await until(() => phone.closed, "phone closed");
    expect(phone.sent).toEqual([{ v: 1, type: "ended", code: "unavailable" }]);
  });

  it("ends the call when the PC disconnects", async () => {
    const pi = await fakePi(join(root, "agent"), 77);
    const url = remoteBridge([{ pid: 77, path: pi.path }]);
    const { phone, tracked } = phoneOn(url);
    const hub = new PiVoiceHub();
    await hub.open(phone);
    await until(() => pi.received.length >= 1, "start");
    tracked[0]!();
    expect(phone.closed).toBe(true);
    hub.close(phone);
    await until(() => pi.closed(), "Pi closed");
  });
});
