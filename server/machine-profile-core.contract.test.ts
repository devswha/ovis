import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodeFrame, FRAME_DATA, makeFrameReader } from "./herdr-core/connection.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const root = resolve(import.meta.dir, "..");
const token = "machine-core-contract-owner";
const headers = { authorization: `Bearer ${token}` };
const DOWN = "herdr-core is not running on this machine for the selected session.";
const REFUSED = "The selected herdr-core socket is not a native socket on a path only this account or root controls.";

/**
 * A core already running on a native socket, as hc's own server listens: the hello and the framed
 * calls an adapter needs to list no terminals. `stop` is a core that ended: its socket is gone.
 */
function nativeCore(path: string) {
  let listener: ReturnType<typeof Bun.listen> | null = null;
  let subscribed = deferred<void>();
  let dropped = deferred<void>();
  let open = 0;
  const calls: string[] = [];
  /** every connection this core ever accepted, probes included */
  const accepted = { count: 0 };
  const answers: Record<string, () => unknown> = {
    "terminal.list": () => ({ terminals: [], hidden_finished: 0 }),
    "doc.get": () => ({ value: null, version: 0 }),
    "machine.list": () => ({ machines: [] }),
  };
  return {
    calls, accepted,
    /** the server's status subscription reached this core: what it serves now comes from here */
    subscribed: () => subscribed.promise,
    /** every line the server had open to this core is closed: take it before the action that closes them */
    dropped: () => dropped.promise,
    start(id: string) {
      rmSync(path, { force: true });
      subscribed = deferred<void>();
      let channel = 1;
      listener = Bun.listen<{ plain: string; frames: ((bytes: Uint8Array) => void) | null }>({ unix: path, socket: {
        open(socket) { socket.data = { plain: "", frames: null }; accepted.count++; open++; },
        close() { if (--open === 0) { dropped.resolve(); dropped = deferred<void>(); } },
        data(socket, bytes) {
          const state = socket.data;
          if (state.frames) { state.frames(bytes); return; }
          state.plain += new TextDecoder().decode(bytes);
          if (!state.plain.includes("\n")) return;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, result: { generation: 1, framed: true, version: "0.1.18", core: { id, name: "profile-test" }, methods: [...Object.keys(answers), "events.subscribe"], features: [] } })}\n`);
          state.frames = makeFrameReader((frame) => {
            if (frame.channel !== 0) return;
            const request = JSON.parse(new TextDecoder().decode(frame.payload)) as { id: number; method: string };
            calls.push(request.method);
            const answer = request.method === "events.subscribe" ? { channel: channel++ } : answers[request.method]?.();
            socket.write(encodeFrame(0, FRAME_DATA, JSON.stringify(answer === undefined
              ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `no ${request.method}`, data: { kind: "unknown_method" } } }
              : { jsonrpc: "2.0", id: request.id, result: answer })));
            if (request.method === "events.subscribe") subscribed.resolve();
          }, () => socket.end());
        },
      } });
      chmodSync(path, 0o600);
    },
    stop() { listener?.stop(true); listener = null; rmSync(path, { force: true }); },
  };
}

/** A stand-in `hc` (OVIS_HC_BIN, and first on the PATH as `hc` and `herdr-core`) that writes down every invocation. */
function recordingHc(dir: string) {
  const bin = join(dir, "bin");
  const log = join(dir, "hc-calls");
  mkdirSync(bin);
  writeFileSync(log, "");
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1" = --version ]; then echo 'hc 0.1.18'; else exit 1; fi\n`;
  for (const name of ["hc", "herdr-core"]) writeFileSync(join(bin, name), script, { mode: 0o700 });
  return { bin, hc: join(bin, "hc"), calls: () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "") };
}

/** The compiled entry's `serve`, in the profile on herdr-core; resolves each stdout line it waits for. */
function launch(dir: string, hc: ReturnType<typeof recordingHc>, socket: string, extra: Record<string, string> = {}) {
  const ready = deferred<string>();
  let output = "";
  const waiters: { line: string; count: number; seen: () => void }[] = [];
  const env: Record<string, string | undefined> = { ...process.env, OVIS_PROFILE: "machine", OVIS_PREVIEW: "fleet", OVIS_RUNTIME: "herdr-core", OVIS_STATE_DIR: join(dir, "state"),
    HOME: join(dir, "home"), XDG_RUNTIME_DIR: join(dir, "run"), XDG_STATE_HOME: join(dir, "xdg-state"), XDG_CONFIG_HOME: join(dir, "config"),
    HC_SOCKET: socket, HC_SESSION: undefined, OVIS_HC_BIN: hc.hc, OVIS_HC_ENV: undefined, PATH: `${hc.bin}:${process.env["PATH"] ?? ""}`,
    OVIS_TOKEN: token, PORT: "0", HOST: "127.0.0.1", OVIS_MANAGED: "0", OVIS_TELEMETRY: "0", OVIS_RELAY_URL: "wss://relay.invalid", ...extra };
  const child = Bun.spawn([process.execPath, "server/main.ts", "serve"], {
    cwd: root, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const count = (line: string) => output.split("\n").filter((said) => said === line).length;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      output += new TextDecoder().decode(chunk);
      const match = /Ovis listening on (http:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) ready.resolve(match[1]);
      for (const waiter of waiters.splice(0)) if (count(waiter.line) >= waiter.count) waiter.seen(); else waiters.push(waiter);
    }
  };
  const drained = Promise.all([read(child.stdout), read(child.stderr)]);
  const exited = child.exited.then(async (code) => { await drained; ready.reject(new Error(output || `Server exited ${code}`)); return code; });
  void ready.promise.catch(() => undefined);
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await bounded(exited, 15_000); });
  return {
    child, ready: ready.promise, output: () => output,
    /** how often `line` has been printed so far */
    seen: count,
    /** subscribed before the action that causes it: resolves once `line` has been printed `times` times in all */
    said(line: string, times: number): Promise<void> {
      const seen = deferred<void>();
      if (count(line) >= times) seen.resolve();
      else waiters.push({ line, count: times, seen: () => seen.resolve() });
      return bounded(seen.promise, 20_000);
    },
  };
}

function world() {
  // under root's sticky /tmp: the core's socket is taken only when every folder above it is safe, which a
  // shared, group-writable TMPDIR need not be
  const dir = mkdtempSync("/tmp/ovis-machine-core-");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["home", "run", "xdg-state", "config"]) mkdirSync(join(dir, name), { mode: 0o700 });
  const socket = join(dir, "run", "native.sock");
  const core = nativeCore(socket);
  cleanup.push(() => core.stop());
  return { dir, socket, core, hc: recordingHc(dir) };
}

async function health(base: string) {
  const response = await fetch(`${base}/api/health`, { headers });
  expect(response.status).toBe(200);
  return await response.json() as { ok: boolean; machine_profile: { engine: string; runtime_down: boolean; reason: string | null }; herdr?: { runtime?: string }; web_ui: { boot_id: string } };
}

/** Every request a page or device makes of an engine, while it is down or back: none may run anything but `hc --version`. */
async function engineRequests(base: string) {
  const answers: number[] = [];
  for (const path of ["/api/session", "/api/health", "/api/health?scope=bridge", "/api/agents"]) answers.push((await fetch(base + path, { headers })).status);
  return answers;
}

const ENGINE_LIFETIME = /^(?:connect|server|serve|hold|start|stop|restart|update|install|uninstall)\b/;

it("serves a herdr-core that starts after it, is killed and returns, and never runs hc but to read its version", async () => {
  const { socket, core, hc, dir } = world();
  const server = launch(dir, hc, socket);
  const base = await bounded(server.ready, 30_000);
  expect(server.output()).toContain(`Machine engine: herdr-core (${DOWN})\n`);
  // absent at the start: the server answers, says why the engine is down, and asks nothing of hc
  const first = await health(base);
  expect(first).toMatchObject({ ok: true, machine_profile: { engine: "herdr-core", runtime_down: true, reason: DOWN } });
  expect(first).not.toHaveProperty("herdr");
  const absent = await engineRequests(base);
  expect(absent[0]).toBe(502);
  expect(hc.calls()).toEqual([]);

  // started by its owner: the server connects by itself, at its own pace
  const up = server.said("Machine engine: herdr-core", 1);
  core.start("first-core");
  await up;
  await bounded(core.subscribed(), 20_000);
  expect(await health(base)).toMatchObject({ machine_profile: { engine: "herdr-core", runtime_down: false, reason: null }, herdr: { runtime: "herdr-core" }, web_ui: { boot_id: first.web_ui.boot_id } });
  expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
  // the one invocation of hc the profile makes: reading the version of the hc it names, once, before its adapter starts
  expect(hc.calls()).toEqual(["--version"]);

  // killed: down again in the same fields, and every request after it reaches no hc but the version read already made
  const gone = server.said(`Machine engine: herdr-core (${DOWN})`, 2);
  core.stop();
  await gone;
  expect(await health(base)).toMatchObject({ machine_profile: { engine: "herdr-core", runtime_down: true, reason: DOWN }, web_ui: { boot_id: first.web_ui.boot_id } });
  for (let round = 0; round < 3; round++) expect((await engineRequests(base))[0]).not.toBe(200);
  expect(hc.calls().filter((call) => ENGINE_LIFETIME.test(call))).toEqual([]);

  // started again by its owner: the same process connects again
  const back = server.said("Machine engine: herdr-core", 2);
  core.start("second-core");
  await back;
  await bounded(core.subscribed(), 20_000);
  expect(await health(base)).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { runtime: "herdr-core" }, web_ui: { boot_id: first.web_ui.boot_id } });
  expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
  expect(server.child.exitCode).toBeNull();
  expect(hc.calls()).toEqual(["--version"]);
  expect(core.calls.filter((method) => method === "terminal.send" || method === "terminal.keys")).toEqual([]);
}, 90_000);

it("connects to a herdr-core that already runs at its start through its native socket, never through hc connect", async () => {
  const { socket, core, hc, dir } = world();
  core.start("running-core");
  const server = launch(dir, hc, socket);
  const base = await bounded(server.ready, 30_000);
  // its start connected before it listened: the version read was all it ran of hc
  expect(hc.calls()).toEqual(["--version"]);
  expect(server.output()).toContain("Machine engine: herdr-core\n");
  await bounded(core.subscribed(), 20_000);
  expect((await health(base)).machine_profile.engine).toBe("herdr-core");
  expect((await engineRequests(base))[0]).toBe(200);
  expect(hc.calls()).toEqual(["--version"]);
}, 60_000);

/** A second core of the owner's, in a folder of its own; its socket, and the core. */
function secondCore(dir: string, name: string) {
  mkdirSync(join(dir, name), { mode: 0o700 });
  const socket = join(dir, name, "native.sock");
  const core = nativeCore(socket);
  cleanup.push(() => core.stop());
  return { socket, core };
}

it("closes its open line at once when the socket's path fails the check, and serves nothing of that core until it passes again", async () => {
  const { socket, core, hc, dir } = world();
  core.start("checked-core");
  const server = launch(dir, hc, socket);
  const base = await bounded(server.ready, 30_000);
  await bounded(core.subscribed(), 20_000);
  expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
  // the folder holding the socket becomes writable by every account: anyone could put another socket there
  const refused = server.said(`Machine engine: herdr-core (${REFUSED})`, 1);
  const dropped = bounded(core.dropped(), 20_000);
  chmodSync(join(dir, "run"), 0o777);
  await refused;
  await dropped;
  expect(await health(base)).toMatchObject({ machine_profile: { engine: "herdr-core", runtime_down: true, reason: REFUSED } });
  expect((await fetch(`${base}/api/session`, { headers })).status).toBe(502);
  // and a request meanwhile opens no line to it either
  const before = core.accepted.count;
  expect((await engineRequests(base))[0]).toBe(502);
  expect(core.accepted.count).toBe(before);
  const back = server.said("Machine engine: herdr-core", server.seen("Machine engine: herdr-core") + 1);
  chmodSync(join(dir, "run"), 0o700);
  await back;
  expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
  expect(hc.calls()).toEqual(["--version"]);
}, 60_000);

it("connects to the real path its check reached: a link on the way changed afterwards sends nothing elsewhere", async () => {
  const { core: unused, hc, dir } = world();
  unused.stop();
  const a = secondCore(dir, "a");
  const b = secondCore(dir, "b");
  symlinkSync(join(dir, "a"), join(dir, "via"));
  a.core.start("core-a");
  b.core.start("core-b");
  const server = launch(dir, hc, join(dir, "via", "native.sock"));
  const base = await bounded(server.ready, 30_000);
  await bounded(a.core.subscribed(), 20_000);
  // the link now names the other core, and the checked one stops
  rmSync(join(dir, "via"));
  symlinkSync(join(dir, "b"), join(dir, "via"));
  const down = server.said(`Machine engine: herdr-core (${DOWN})`, 1);
  a.core.stop();
  await down;
  expect((await engineRequests(base))[0]).toBe(502);
  // the checked core comes back: the same real path is served again
  const back = server.said("Machine engine: herdr-core", server.seen("Machine engine: herdr-core") + 1);
  a.core.start("core-a-again");
  await back;
  expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
  expect(b.core.accepted.count).toBe(0);
}, 60_000);

it("connects to exactly the socket it checked: OVIS_HC_ENV redirects nothing under the existing-only policy", async () => {
  const { socket, core, hc, dir } = world();
  const other = secondCore(dir, "other");
  core.start("checked-core");
  other.core.start("other-core");
  const server = launch(dir, hc, socket, { OVIS_HC_ENV: JSON.stringify({ HC_SOCKET: other.socket }) });
  const base = await bounded(server.ready, 30_000);
  await bounded(core.subscribed(), 20_000);
  expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
  expect(other.core.accepted.count).toBe(0);
}, 60_000);
