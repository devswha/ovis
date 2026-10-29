import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { CLOSE, IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG, MAX_CLIENTS, type Frame } from "./core.ts";
import { RelayRoom, handle, type Env, type HibernatableSocket, type RelayState } from "./worker.ts";

/** the server end of a Cloudflare WebSocketPair: records what the room sends and how it closes */
class FakeSocket implements HibernatableSocket {
  sent: Frame[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private attachment: unknown = null;
  send(frame: Frame) {
    if (this.closedWith) throw new Error("socket closed");
    this.sent.push(frame);
  }
  close(code = 1005, reason = "") {
    if (this.closedWith) throw new Error("already closed");
    this.closedWith = { code, reason };
  }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  json(index: number) { return JSON.parse(this.sent[index] as string) as Record<string, unknown>; }
}

const runtime = globalThis as unknown as Record<string, unknown>;
const saved = { WebSocketPair: runtime["WebSocketPair"], WebSocketRequestResponsePair: runtime["WebSocketRequestResponsePair"] };
beforeAll(() => {
  runtime["WebSocketPair"] = class { 0 = new FakeSocket(); 1 = new FakeSocket(); };
  runtime["WebSocketRequestResponsePair"] = class { constructor(readonly request: string, readonly response: string) {} };
});
afterAll(() => Object.assign(runtime, saved));
afterEach(() => setSystemTime());

/** DurableObjectState over the fake sockets; it outlives a RelayRoom as the real one outlives an eviction */
function fakeState() {
  const sockets: FakeSocket[] = [];
  const keepalive = new Map<HibernatableSocket, Date>();
  const state: RelayState & { autoResponse: unknown; alarm: number | null } = {
    autoResponse: null,
    alarm: null,
    acceptWebSocket: (socket: HibernatableSocket) => { sockets.push(socket as FakeSocket); },
    // the runtime stops listing a socket once its close is through
    getWebSockets: () => sockets.filter((socket) => !socket.closedWith),
    setWebSocketAutoResponse: (pair?: unknown) => { state.autoResponse = pair; },
    getWebSocketAutoResponseTimestamp: (socket: HibernatableSocket) => keepalive.get(socket) ?? null,
    storage: {
      getAlarm: async () => state.alarm,
      setAlarm: async (time: number) => { state.alarm = time; },
    },
  };
  return { state, sockets, keepalive };
}

const SERVER = "0123456789abcdef0123456789abcdef";
const url = (query: string) => `https://relay.test/v1/ws?server_id=${SERVER}&v=1&${query}`;
const upgrade = { headers: { upgrade: "websocket" } };

/** opens a socket on the room; returns the server end the room holds */
async function connect(room: RelayRoom, fake: ReturnType<typeof fakeState>, query: string): Promise<FakeSocket> {
  const response = await room.fetch(new Request(url(query), upgrade));
  expect(response.status).toBe(101);
  return fake.sockets.at(-1)!;
}

/** what the runtime does when a socket closes: the room hears it */
function closeFromFar(room: RelayRoom, socket: FakeSocket) {
  socket.closedWith ??= { code: 1000, reason: "" };
  room.webSocketClose(socket);
}

describe("relay Durable Object", () => {
  test("lets the runtime answer the keepalive, so an idle PC does not wake it", () => {
    const fake = fakeState();
    new RelayRoom(fake.state);
    expect(fake.state.autoResponse).toEqual({ request: KEEPALIVE_PING, response: KEEPALIVE_PONG });
  });

  test("pairs control, client and data and passes frames unchanged, across an eviction", async () => {
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    const control = await connect(room, fake, "role=server");
    expect(control.json(0)).toEqual({ type: "sync", connection_ids: [] });
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    expect(connection_id).toMatch(/^[0-9a-f]{32}$/);
    expect(control.json(1)).toEqual({ type: "connected", connection_id });
    const data = await connect(room, fake, `role=server&connection_id=${connection_id}`);

    // evicted: a new instance knows the sockets only from their attachments
    room = new RelayRoom(fake.state);
    const binary = crypto.getRandomValues(new Uint8Array(4096)).buffer;
    room.webSocketMessage(client, binary);
    expect(data.sent).toEqual([binary]);
    expect(data.sent[0]).toBe(binary);
    room.webSocketMessage(data, "text back");
    expect(client.sent.at(-1)).toBe("text back");
    // the control socket never hears a client's frames
    expect(control.sent).toHaveLength(2);
  });

  test("closes a client 1012 whose held frames an evicted instance took with it", async () => {
    const fake = fakeState();
    const before = new RelayRoom(fake.state);
    await connect(before, fake, "role=server");
    const client = await connect(before, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    before.webSocketMessage(client, "held");
    const after = new RelayRoom(fake.state);
    const data = await connect(after, fake, `role=server&connection_id=${connection_id}`);
    expect(client.closedWith?.code).toBe(CLOSE.RESTART);
    expect(data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
  });

  test("a second control socket replaces the first with 1008; the 9th client is refused 1013; unknown versions 1008", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const first = await connect(room, fake, "role=server");
    const second = await connect(room, fake, "role=server");
    expect(first.closedWith?.code).toBe(CLOSE.POLICY);
    expect(second.closedWith).toBeNull();
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const client = await connect(room, fake, "role=client");
      await connect(room, fake, `role=server&connection_id=${(client.json(0) as { connection_id: string }).connection_id}`);
    }
    const ninth = await connect(room, fake, "role=client");
    expect(ninth.closedWith?.code).toBe(CLOSE.TRY_AGAIN);
    const response = await room.fetch(new Request(`https://relay.test/v1/ws?server_id=${SERVER}&role=client&v=9`, upgrade));
    expect(response.status).toBe(101);
    expect(fake.sockets.at(-1)!.closedWith?.code).toBe(CLOSE.POLICY);
  });

  test("propagates closes: client gone closes data 1001, data gone closes client 1012", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const control = await connect(room, fake, "role=server");
    const pair = async () => {
      const client = await connect(room, fake, "role=client");
      const { connection_id } = client.json(0) as { connection_id: string };
      return { client, connection_id, data: await connect(room, fake, `role=server&connection_id=${connection_id}`) };
    };
    const one = await pair();
    closeFromFar(room, one.client);
    expect(one.data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(JSON.parse(control.sent.at(-1) as string)).toEqual({ type: "disconnected", connection_id: one.connection_id });
    // the runtime's own close event for the data socket changes nothing more
    room.webSocketClose(one.data);
    const two = await pair();
    closeFromFar(room, two.data);
    expect(two.client.closedWith?.code).toBe(CLOSE.RESTART);
  });

  test("an alarm closes sockets idle for 120 s; a PC kept alive by the runtime's keepalive stays", async () => {
    const start = new Date("2026-10-29T12:00:00Z");
    setSystemTime(start);
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const control = await connect(room, fake, "role=server");
    const client = await connect(room, fake, "role=client");
    expect(fake.state.alarm).toBe(start.getTime() + IDLE_MS);

    setSystemTime(new Date(start.getTime() + IDLE_MS - 1000));
    fake.keepalive.set(control, new Date());
    await room.alarm();
    expect(client.closedWith).toBeNull();

    setSystemTime(new Date(start.getTime() + IDLE_MS));
    await room.alarm();
    expect(client.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(control.closedWith).toBeNull();
    expect(fake.state.alarm).toBe(start.getTime() + 2 * IDLE_MS - 1000);
  });

  test("after an eviction, closes an idle pair no sooner than 120 s after its last frame and by 150 s after the saved time", async () => {
    const at = (ms: number) => setSystemTime(new Date(ms));
    at(1_000_000);
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    await connect(room, fake, "role=server");
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    const data = await connect(room, fake, `role=server&connection_id=${connection_id}`);
    // traffic both ways 29 s in: under the 30 s write interval, so the saved last-seen stays at 1000000
    at(1_029_000);
    room.webSocketMessage(client, new Uint8Array([1, 2, 3]).buffer);
    room.webSocketMessage(data, new Uint8Array([4, 5, 6]).buffer);
    expect(data.sent).toHaveLength(1);

    room = new RelayRoom(fake.state);
    at(1_120_000);
    await room.alarm();
    expect([client.closedWith, data.closedWith]).toEqual([null, null]);
    expect(fake.state.alarm).toBe(1_150_000);
    // 1 ms short of 120 s since the last frame
    at(1_148_999);
    await room.alarm();
    expect([client.closedWith, data.closedWith]).toEqual([null, null]);
    at(1_150_000);
    await room.alarm();
    expect(client.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
  });
});

describe("relay Worker", () => {
  function env() {
    const asked: string[] = [];
    const limiter = (name: string) => {
      const value = { allow: true, limit: async ({ key }: { key: string }) => { asked.push(`${name}:${key}`); return { success: value.allow }; } };
      return value;
    };
    const rooms: string[] = [];
    const value = {
      RELAY: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: async () => { rooms.push(id as string); return new Response(null, { status: 101 }); } }) },
      RELAY_LIMITER: limiter("address"),
      RELAY_GLOBAL_LIMITER: limiter("global"),
    } satisfies Env;
    return { env: value, asked, rooms };
  }
  const socketRequest = (query = "role=client") => new Request(url(query), { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.9" } });

  test("answers /health without a Durable Object", async () => {
    const { env: e, rooms, asked } = env();
    const response = await handle(new Request("https://relay.test/health"), e);
    expect([response.status, await response.text()]).toEqual([200, "ok"]);
    expect(rooms).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("routes an admitted socket to its server_id's Durable Object", async () => {
    const { env: e, rooms, asked } = env();
    expect((await handle(socketRequest(), e)).status).toBe(101);
    expect(rooms).toEqual([SERVER]);
    expect(asked).toEqual(["address:203.0.113.9", "global:all"]);
  });

  test("refuses an address over its limit with 429 before any Durable Object, and asks the backstop only after", async () => {
    const { env: e, rooms, asked } = env();
    e.RELAY_LIMITER.allow = false;
    const response = await handle(socketRequest(), e);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(asked).toEqual(["address:203.0.113.9"]);
    e.RELAY_LIMITER.allow = true;
    e.RELAY_GLOBAL_LIMITER.allow = false;
    expect((await handle(socketRequest(), e)).status).toBe(429);
    expect(rooms).toEqual([]);
  });

  test("refuses malformed requests with 400 before asking any limiter", async () => {
    const { env: e, rooms, asked } = env();
    const bad = new Request(`https://relay.test/v1/ws?server_id=nothex&role=client&v=1`, { headers: { upgrade: "websocket" } });
    expect((await handle(bad, e)).status).toBe(400);
    expect(asked).toEqual([]);
    expect(rooms).toEqual([]);
  });
});
