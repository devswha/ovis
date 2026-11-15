import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { agentGet, HerdrError, herdrRpc, makeLineReader, paneGet, paneProcessInfo, paneRead, ping, sessionSnapshot, subscribeEvents } from "../herdr/client.ts";
import { encodeFrame, FRAME_CLOSE, FRAME_DATA, HcConnection, type HcTransport, makeFrameReader } from "../herdr-core/connection.ts";
import { startHerdrCoreAdapter } from "../herdr-core/adapter.ts";
import { adapterAddress } from "../herdr-core/pipe.ts";
import type { HcTerminal } from "../herdr-core/snapshot.ts";
import type { BoundaryFault, BoundaryReadMethod, ConnectionModel } from "./boundary.ts";

/**
 * One contract for every runtime behind the server: each case asks through the server's own
 * herdr client (server/herdr/client.ts) and checks only the answer, never how a runtime makes it,
 * so a second runtime's adapter passes or fails it on what it answers.
 *
 * A runtime comes from a factory: the herdr-core adapter over a fake hc transport, which needs
 * neither a herdr nor a runtime binary.
 *
 * `BOUNDARY_FAULT` (boundary.ts `BoundaryFault`) breaks one runtime answer on purpose, so each
 * case family is shown to fail on its own fault and on no other.
 */

/** A pane the cases read; what it should show is checked when the factory says it. */
interface BoundaryPane {
  id: string;
  /** the screen's text, as a visible read answers it */
  screen?: string;
  /** a line above the screen, which a recent read has and a visible read has not */
  history?: string;
  /** the agent the runtime names in it */
  agent?: string;
  /** the pid of the program the pane's terminal started, as `pane.process_info` names its shell */
  shellPid?: number;
}

interface BoundaryRuntime {
  socket: string;
  /** the runtime's name in its ping's capabilities; undefined for herdr's own server, which names none */
  runtime?: string;
  /** a pane with an agent, and another pane */
  agentPane: BoundaryPane;
  plainPane: BoundaryPane;
  /** what a second request on one connection gets (boundary.ts `ConnectionModel`) */
  connection: ConnectionModel;
  /** a second `events.subscribe` on one connection: herdr's own way ignores it, a persistent runtime acknowledges it */
  secondSubscribe: "ignored" | "acknowledged";
  /** how a read's text holds `screen`: exactly (a fake transport), or within a real screen's lines */
  screens: "exact" | "contained";
  /** ends every open event subscription as the runtime ends one that fell behind; undefined where nothing outside the runtime can force it */
  missSubscribers?: () => void;
  /** ends the runtime; a real runtime's stop may take its own 30 s hang guard */
  stop: () => void | Promise<void>;
}

type BoundaryFactory = () => Promise<BoundaryRuntime>;

/** Every runtime case waits at most this long for an answer or an event: past it the case fails, it never hangs. */
const BOUND_MS = 2_000;

const fault = (process.env["BOUNDARY_FAULT"] ?? "") as BoundaryFault | "";

/** `work`, or a failure naming `what` once BOUND_MS passed. */
async function bounded<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no ${what} within ${BOUND_MS} ms`)), BOUND_MS); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The code a runtime refused with, or the answer it gave instead. */
function refusal(work: Promise<unknown>): Promise<string | { answered: unknown }> {
  return work.then((answered) => ({ answered }), (error: unknown) => (error instanceof HerdrError ? error.code : String(error)));
}

/** A core behind a fake `hc connect`: answers channel 0 from `handlers`, ends a viewer's stream when it closes it. */
class FakeHc implements HcTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly exited: Promise<unknown>;
  replyTail: Uint8Array = new Uint8Array(0);
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private endExited!: () => void;
  private plain = true;
  private nextChannel = 1;
  private readonly frames = makeFrameReader((frame) => this.onFrame(frame.channel, frame.kind, frame.payload), () => {});

  constructor(private readonly handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
    const { promise, resolve } = Promise.withResolvers<unknown>();
    this.exited = promise;
    this.endExited = () => resolve(null);
  }

  write(bytes: Uint8Array): void {
    if (this.plain) {
      this.plain = false;
      this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: 0, jsonrpc: "2.0", result: { generation: 1, framed: true, version: "0.1.14", core: { id: "c1", name: "lab" }, methods: Object.keys(this.handlers), features: [] } })}\n`));
      return;
    }
    this.frames(bytes);
  }

  kill(): void {
    try { this.controller.close(); } catch { /* closed */ }
    this.endExited();
  }

  notify(channel: number, method: string, params: Record<string, unknown>): void {
    this.controller.enqueue(encodeFrame(channel, FRAME_DATA, `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`));
  }

  channel(): number {
    return this.nextChannel++;
  }

  private onFrame(channel: number, kind: number, payload: Uint8Array): void {
    if (channel !== 0) {
      if (kind === FRAME_CLOSE) this.controller.enqueue(encodeFrame(channel, FRAME_CLOSE, new Uint8Array(0)));
      return;
    }
    const message = JSON.parse(new TextDecoder().decode(payload)) as { id: number; method: string; params: Record<string, unknown> };
    const handler = this.handlers[message.method];
    let reply: Record<string, unknown>;
    try {
      reply = handler ? { result: handler(message.params) } : { error: { code: -32601, message: `no ${message.method}`, data: { kind: "unknown_method" } } };
    } catch (error) {
      reply = { error: { code: -32000, message: String(error), data: { kind: "not_found" } } };
    }
    this.controller.enqueue(Buffer.concat([encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })), this.replyTail]));
    this.replyTail = new Uint8Array(0);
  }
}

/** hc's first paint of a main-screen terminal for a watch-only attach (as hc 0.1.14 paints): reset, clear, screen, win32-input-mode state. */
const paintOf = (screen: string) => `\u0018\u001b[!p\u001b[?2026l\u001b[?1049l\u001b[H\u001b[2J\u001b[H\u001b[0m${screen}\r\n\u001b[?9001l`;

const HC_PANES: Record<string, Required<Pick<BoundaryPane, "screen" | "history">>> = {
  t1: { screen: "claude screen t1", history: "older line t1" },
  t2: { screen: "shell screen t2", history: "older line t2" },
};

const herdrCore: BoundaryFactory = async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-boundary-"));
  // where the server starts its adapter: a socket in the folder, a named pipe on Windows
  const socket = adapterAddress(dir);
  const cores: FakeHc[] = [];
  const events: { core: FakeHc; channel: number }[] = [];
  const terminals: HcTerminal[] = [
    { address: "t1", cols: 100, rows: 30, cwd: "/home/u", state: "live", pid: 101, status: { app: "claude-code", state: "idle" }, foreground: { pid: 111, name: "claude" } },
    { address: "t2", cols: 100, rows: 30, cwd: "/home/u", state: "live", pid: 202 },
  ];
  const find = (params: Record<string, unknown>) => {
    const found = terminals.find((entry) => entry.address === params["terminal"]);
    if (!found) throw new Error(`no terminal ${String(params["terminal"])}`);
    return found;
  };
  const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    "terminal.list": () => ({ terminals, hidden_finished: 0 }),
    // no Herdr app document: every terminal shows in Ovis's own "Other terminals" group
    "doc.get": () => ({ value: null, version: 0 }),
    "terminal.get": (params) => find(params),
    // hc reads the screen plus `lines` of history above it
    "terminal.read": (params) => {
      const pane = HC_PANES[find(params)["address"]]!;
      const history = fault === "recent-without-history" ? false : Number(params["lines"] ?? 0) > 0;
      return { text: history ? `${pane.history}\n${pane.screen}` : pane.screen, complete: true, how: history ? "history" : "screen" };
    },
    "terminal.attach": (params) => {
      const core = cores.at(-1)!;
      const channel = core.channel();
      core.replyTail = encodeFrame(channel, FRAME_DATA, paintOf(HC_PANES[find(params)["address"]]!.screen));
      return { channel, terminal: find(params) };
    },
    "events.subscribe": () => {
      const core = cores.at(-1)!;
      const channel = core.channel();
      events.push({ core, channel });
      return { channel, seq: 1, terminals };
    },
    "machine.list": () => ({ machines: [] }),
  };
  const hc = new HcConnection(() => {
    const core = new FakeHc(handlers);
    cores.push(core);
    return core;
  });
  const adapter = await startHerdrCoreAdapter(hc, socket);
  return {
    socket,
    runtime: "herdr-core",
    agentPane: { id: "t1", ...HC_PANES["t1"], agent: "claude", shellPid: 101 },
    plainPane: { id: "t2", ...HC_PANES["t2"], shellPid: 202 },
    // the adapter reads one request per connection and closes after its answer, as herdr does (adapter.ts `open`)
    connection: "per-request",
    secondSubscribe: "ignored",
    screens: "exact",
    // hc ends a subscriber that fell behind with `missed`
    missSubscribers: () => {
      if (fault === "missed-not-sent") return;
      for (const { core, channel } of events) core.notify(channel, "missed", { seq: 9, terminals: [] });
    },
    stop: () => {
      adapter.stop();
      hc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/**
 * A socket in front of `upstream` that breaks one answer as `fault` says: `wrong-pane` answers a
 * request whose target field is misnamed for the other pane (herdr's own trap: the focused pane);
 * `second-request-dropped` passes only a connection's first request on and then holds a request
 * connection open (a subscription still ends as the runtime ends it), answering nothing more.
 */
async function faulty(runtime: BoundaryRuntime, fault: "wrong-pane" | "second-request-dropped"): Promise<BoundaryRuntime> {
  const dir = mkdtempSync(join(tmpdir(), "ovis-boundary-fault-"));
  const socket = adapterAddress(dir);
  type State = { upstream: Promise<Socket<undefined>> | null; lines: number; held: boolean; read: (chunk: Uint8Array) => void };
  const rewrite = (line: string): string => {
    if (fault !== "wrong-pane") return line;
    const request = JSON.parse(line) as { params?: Record<string, unknown> };
    const params = request.params ?? {};
    if ("paneid" in params && !("pane_id" in params) && !("target" in params)) {
      request.params = { ...params, pane_id: runtime.plainPane.id, target: runtime.plainPane.id };
    }
    return JSON.stringify(request);
  };
  const listener = Bun.listen<State>({
    unix: socket,
    socket: {
      open(client) {
        client.data = {
          upstream: null,
          lines: 0,
          held: false,
          read: makeLineReader(1 << 24, (line) => {
            client.data.lines += 1;
            if (client.data.lines === 1) client.data.held = fault === "second-request-dropped" && !line.includes("\"events.subscribe\"");
            if (fault === "second-request-dropped" && client.data.lines > 1) return;
            client.data.upstream ??= Bun.connect({
              unix: runtime.socket,
              socket: {
                data(_upstream, chunk) { client.write(chunk); },
                close() { if (!client.data.held) client.end(); },
              },
            });
            void client.data.upstream.then((upstream) => upstream.write(`${rewrite(line)}\n`));
          }, () => client.end()),
        };
      },
      data(client, chunk) { client.data.read(chunk); },
      close(client) { void client.data.upstream?.then((upstream) => upstream.end()); },
    },
  });
  return {
    ...runtime,
    socket,
    stop: async () => {
      listener.stop(true);
      rmSync(dir, { recursive: true, force: true });
      await runtime.stop();
    },
  };
}

const factories: [string, BoundaryFactory][] = [["herdr-core", herdrCore]];

/** One request and what it gets on a raw connection: the lines answered, and whether the runtime closed it. */
class RawConnection {
  readonly answers: Record<string, unknown>[] = [];
  private readonly closed = Promise.withResolvers<void>();
  private waiting: (() => void) | null = null;
  private socket!: Socket<undefined>;

  static async open(path: string): Promise<RawConnection> {
    const connection = new RawConnection();
    const read = makeLineReader(1 << 24, (line) => {
      connection.answers.push(JSON.parse(line) as Record<string, unknown>);
      connection.waiting?.();
    }, () => {});
    connection.socket = await Bun.connect({ unix: path, socket: { data: (_socket, chunk) => read(chunk), close: () => connection.closed.resolve() } });
    return connection;
  }

  /** Sends one request; false when the runtime had closed the connection already. */
  send(id: string, method: BoundaryReadMethod, params: Record<string, unknown>): boolean {
    return this.socket.write(`${JSON.stringify({ id, method, params })}\n`) !== -1;
  }

  /** the answer to request `id`, or null once the runtime closed the connection without one */
  answerTo(id: string): Promise<Record<string, unknown> | null> {
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        this.waiting = () => {
          const found = this.answers.find((answer) => answer["id"] === id);
          if (found) resolve(found);
        };
        this.waiting();
      }),
      this.closed.promise.then(() => null),
    ]);
  }

  /** the next answer, or the close: whichever comes first */
  next(): Promise<"answer" | "closed"> {
    const answered = this.answers.length;
    return Promise.race([
      new Promise<"answer">((resolve) => {
        this.waiting = () => { if (this.answers.length > answered) resolve("answer"); };
        this.waiting();
      }),
      this.closed.promise.then(() => "closed" as const),
    ]);
  }

  end(): void {
    this.socket.end();
  }
}

for (const [name, factory] of factories) {
  describe(`runtime boundary: ${name}`, () => {
    let runtime: BoundaryRuntime;
    // a real runtime starts within its 30 s ready bound and stops within its 30 s hang guard
    beforeEach(async () => {
      runtime = await factory();
      if (fault === "wrong-pane" || fault === "second-request-dropped") runtime = await faulty(runtime, fault);
    }, 60_000);
    afterEach(async () => { await runtime.stop(); }, 60_000);

    it("answers ping with its version, protocol and name", async () => {
      const identity = await bounded("ping", ping(runtime.socket));
      expect(identity.version).toBeString();
      expect(identity.version).not.toBe("");
      expect(Number.isInteger(identity.protocol) && identity.protocol > 0).toBe(true);
      const said = await bounded("ping", herdrRpc<{ capabilities?: Record<string, unknown> }>("ping", {}, runtime.socket));
      expect(said.capabilities?.["runtime"]).toBe(runtime.runtime);
    });

    it("lists both panes in its session snapshot, each in a tab and workspace the snapshot holds", async () => {
      const snapshot = await bounded("session snapshot", sessionSnapshot(runtime.socket));
      const panes = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
      for (const id of [runtime.agentPane.id, runtime.plainPane.id]) {
        const pane = panes.get(id);
        expect(pane?.pane_id).toBe(id);
        expect(snapshot.tabs.map((tab) => tab.tab_id)).toContain(pane!.tab_id);
        expect(snapshot.workspaces.map((workspace) => workspace.workspace_id)).toContain(pane!.workspace_id);
      }
      expect(panes.get(runtime.agentPane.id)?.agent ?? undefined).toBe(runtime.agentPane.agent);
    });

    it("answers pane.get for the pane asked, and pane_not_found for one it does not hold", async () => {
      const snapshot = await bounded("session snapshot", sessionSnapshot(runtime.socket));
      for (const id of [runtime.agentPane.id, runtime.plainPane.id]) {
        const pane = await bounded("pane.get", paneGet(id, runtime.socket));
        const listed = snapshot.panes.find((entry) => entry.pane_id === id)!;
        expect([pane.pane_id, pane.tab_id, pane.workspace_id]).toEqual([id, listed.tab_id, listed.workspace_id]);
      }
      expect(await bounded("pane.get", refusal(paneGet("no-such-pane", runtime.socket)))).toBe("pane_not_found");
    });

    it("answers agent.get with the agent in the pane asked", async () => {
      const agent = await bounded("agent.get", agentGet(runtime.agentPane.id, runtime.socket));
      expect(agent.pane_id).toBe(runtime.agentPane.id);
      if (runtime.agentPane.agent !== undefined) expect(agent.agent).toBe(runtime.agentPane.agent);
      // a pane whose program names no agent has none: nothing is inferred for it
      if (runtime.agentPane.agent !== undefined) expect(await bounded("agent.get", refusal(agentGet(runtime.plainPane.id, runtime.socket)))).toBe("agent_not_found");
    });

    it("answers process_info for the pane asked", async () => {
      for (const id of [runtime.agentPane.id, runtime.plainPane.id]) {
        const info = await bounded("pane.process_info", paneProcessInfo(id, runtime.socket));
        expect(info?.pane_id).toBe(id);
      }
      // by the processes themselves, not only the pane id echoed back
      for (const pane of [runtime.agentPane, runtime.plainPane]) {
        if (pane.shellPid === undefined) continue;
        const info = await bounded("pane.process_info", paneProcessInfo(pane.id, runtime.socket));
        expect(info?.shell_pid).toBe(pane.shellPid);
      }
    });

    it("reads a pane's visible screen, without the history above it", async () => {
      for (const pane of [runtime.agentPane, runtime.plainPane]) {
        const read = await bounded("pane.read", paneRead({ paneId: pane.id, source: "visible" }, runtime.socket));
        expect([read.pane_id, read.source]).toEqual([pane.id, "visible"]);
        if (pane.screen !== undefined && runtime.screens === "exact") expect(read.text).toBe(pane.screen);
        if (pane.screen !== undefined && runtime.screens === "contained") expect(read.text.split("\n")).toContain(pane.screen);
        if (pane.history !== undefined) expect(read.text).not.toContain(pane.history);
      }
    });

    it("reads a pane's recent lines, the history above the screen included", async () => {
      for (const pane of [runtime.agentPane, runtime.plainPane]) {
        const read = await bounded("pane.read", paneRead({ paneId: pane.id, source: "recent", lines: 50 }, runtime.socket));
        expect([read.pane_id, read.source]).toEqual([pane.id, "recent"]);
        if (pane.history !== undefined) expect(read.text.split("\n")).toContain(pane.history);
        if (pane.screen !== undefined && runtime.screens === "exact") expect(read.text.endsWith(pane.screen)).toBe(true);
        if (pane.screen !== undefined && runtime.screens === "contained") expect(read.text.split("\n")).toContain(pane.screen);
      }
    });

    it("ends an event subscription that fell behind (`missed`) by closing it", async () => {
      const started = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const subscription = subscribeEvents([{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: runtime.agentPane.id }], {
        onEvent: () => {},
        onStarted: () => started.resolve(),
        onError: (error) => started.reject(error),
        onClose: () => closed.resolve(),
      }, runtime.socket);
      try {
        await bounded("subscription_started", started.promise);
        runtime.missSubscribers!();
        await bounded("close after missed", closed.promise);
      } finally {
        subscription.close();
      }
    });

    // the `ignored` model is shown by the close that ends the first subscription, which the missed fault withholds
    it.skipIf(fault === "missed-not-sent")("ignores or acknowledges a second subscribe on one connection, as the runtime says", async () => {
      const connection = await RawConnection.open(runtime.socket);
      try {
        connection.send("s1", "events.subscribe", { subscriptions: [{ type: "pane.created" }] });
        expect(await bounded("first subscribe", connection.answerTo("s1"))).toMatchObject({ result: { type: "subscription_started" } });
        connection.send("s2", "events.subscribe", { subscriptions: [{ type: "pane.agent_status_changed", pane_id: runtime.agentPane.id }] });
        if (runtime.secondSubscribe === "acknowledged") {
          expect(await bounded("second subscribe", connection.answerTo("s2"))).toMatchObject({ result: { type: "subscription_started" } });
        } else {
          // herdr's way: the second subscribe goes unanswered; the subscription it would replace ends as the first one's does
          runtime.missSubscribers!();
          expect(await bounded("the subscription's close", connection.answerTo("s2"))).toBeNull();
        }
      } finally {
        connection.end();
      }
    });

    it("refuses a misnamed target field with invalid_params, never answering for another pane", async () => {
      const asked = { paneid: runtime.agentPane.id };
      for (const method of ["pane.process_info", "pane.get", "pane.read", "agent.get"] as const satisfies readonly BoundaryReadMethod[]) {
        // the misnamed field goes out as a caller's slip would: herdrRpc's untyped form, as server code may not
        const answer = await bounded(method, refusal(herdrRpc<unknown>(method, asked, runtime.socket)));
        expect({ method, answer }).toEqual({ method, answer: "invalid_params" });
      }
    });

    it("answers a second request on one connection, or ends the connection after the first answer, as the runtime says", async () => {
      const connection = await RawConnection.open(runtime.socket);
      try {
        connection.send("first", "pane.get", { pane_id: runtime.agentPane.id });
        expect(await bounded("first answer", connection.next())).toBe("answer");
        expect(connection.answers[0]).toMatchObject({ id: "first", result: { pane: { pane_id: runtime.agentPane.id } } });
        const sent = connection.send("second", "pane.get", { pane_id: runtime.plainPane.id });
        const outcome = await bounded("second answer or close", connection.next());
        if (runtime.connection === "persistent") {
          expect([sent, outcome]).toEqual([true, "answer"]);
          expect(connection.answers[1]).toMatchObject({ id: "second", result: { pane: { pane_id: runtime.plainPane.id } } });
        } else {
          // herdr's own model: one request per connection, then the runtime closes it; the second is never answered
          expect(outcome).toBe("closed");
          expect(connection.answers).toHaveLength(1);
        }
      } finally {
        connection.end();
      }
    });
  });
}
