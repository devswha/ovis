import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Routing } from "../src/routing.mjs";

// No default profile, detached broker, real Pi, herdr session, provider or credentials.
test("exact public client routes to synthetic peers on an isolated broker", { timeout: 20000 }, async (t) => {
  const state = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-routing-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = state;
  const env = { ...process.env, PI_CODING_AGENT_DIR: state };
  for (const key of Object.keys(env)) {
    if (/^(HERDR|TMUX|PI_INTERCOM)/.test(key)) delete env[key];
  }
  // The test process uses the same explicitly isolated scope as the broker.
  const previousScope = process.env.PI_INTERCOM_SCOPE_ID;
  delete process.env.PI_INTERCOM_SCOPE_ID;
  const brokerPath = fileURLToPath(new URL("../node_modules/pi-intercom/broker/broker.ts", import.meta.url));
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const broker = spawn(process.execPath, ["--import", loader, brokerPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(broker, "exit");
  t.signal.addEventListener("abort", () => broker.kill("SIGTERM"), { once: true });
  const endpoints = [];
  let routing;
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      broker.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("Intercom broker started")) resolve();
      });
      broker.once("error", reject);
      broker.once("exit", () => reject(new Error("Isolated broker exited before startup.")));
    });
    const { createEndpoint } = await import("../src/intercom.mjs");
    function endpoint(id, kind) {
      const value = createEndpoint(id, kind);
      endpoints.push(value);
      return value;
    }
    const observer = endpoint("test-observer", "service");
    const agent = endpoint("test-pi-peer", "agent");
    await observer.connect();
    await agent.connect();
    let replyResolve;
    const reply = new Promise((resolve) => { replyResolve = resolve; });
    routing = new Routing(observer, (id) => endpoint(id, "human"), (event) => replyResolve(event.text));
    const roster = await routing.list();
    assert.equal(roster.length, 1);
    assert.equal(roster[0].id, "test-pi-peer");
    let replySend;
    agent.onMessage((from) => {
      replySend = agent.sendExact({ id: from.id, endpointEpoch: from.endpointEpoch }, { text: "synthetic reply" });
    });
    await routing.select(roster[0].id, roster[0].endpointEpoch);
    const result = await routing.send("synthetic request");
    assert.equal(result.delivery, "socket_delivered");
    assert.equal(result.outcomeKnown, true);
    assert.equal(await reply, "synthetic reply");
    await replySend;
    await agent.disconnect();
    await assert.rejects(routing.send("offline"));
    await routing.end();
  } finally {
    await routing?.end();
    await Promise.allSettled(endpoints.map((endpoint) => endpoint.disconnect()));
    if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
    await exited;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousScope === undefined) delete process.env.PI_INTERCOM_SCOPE_ID;
    else process.env.PI_INTERCOM_SCOPE_ID = previousScope;
    await rm(state, { recursive: true, force: true });
  }
});

test("public client refuses a broker missing either required capability", { timeout: 10000 }, async () => {
  const state = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-routing-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = state;
  const { getBrokerSocketPath } = await import("pi-intercom/client");
  const { createEndpoint } = await import("../src/intercom.mjs");
  await mkdir(join(state, "intercom"));
  try {
    for (const features of [["exact-send-v1"], ["offline-delivery-reject-v1"]]) {
      const sockets = new Set();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("data", () => {
          const payload = Buffer.from(JSON.stringify({ type: "registered", sessionId: "test-human", features }));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(payload.length);
          socket.write(Buffer.concat([header, payload]));
        });
      });
      server.listen(getBrokerSocketPath());
      await once(server, "listening");
      const human = createEndpoint("test-human", "human");
      try {
        await assert.rejects(human.connect(), /does not support/);
        assert.equal(human.connected, false);
      } finally {
        await human.disconnect();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(state, { recursive: true, force: true });
  }
});
