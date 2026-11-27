import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import type { CompletionTracker } from "./completion.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { SshConnection } from "./ssh.ts";

const origin = "http://127.0.0.1:7317";
const headers = { origin, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-machine-forward-"));
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("local fixture offline"); });
  type Runtime = { machine: Machine; ssh?: SshConnection };
  const internals = manager as unknown as { machines: Map<string, Runtime>; runtime(machine: Machine): Runtime };
  const target = { destination: "fixture-pc" };
  const ssh = new SshConnection(target, dir);
  let masterClosed = false;
  Object.assign(ssh, { master: { exitCode: null, signalCode: null, kill() { masterClosed = true; } } });
  const runtime = internals.runtime({ id: "desk", kind: "ssh", name: "Desk", target, enabled: true, state: "connected", snapshot: null, error: null });
  runtime.ssh = ssh;
  internals.machines.set("desk", runtime);
  internals.machines.set("relay", internals.runtime({ id: "relay", kind: "relay", name: "Relay", enabled: true, state: "connected", snapshot: null, error: null }));
  const active = new Set<number>();
  const closed: number[] = [];
  const open = (remote: number) => {
    active.add(remote);
    return {
      listening: () => active.has(remote),
      close: async () => { if (active.delete(remote)) closed.push(remote); },
    };
  };
  const forward = spyOn(ssh, "forward").mockImplementation(async (_local, remote) => open(remote));
  const send = (suffix: string, method: string, body?: unknown, options: {
    owner?: boolean; readOnly?: boolean; headers?: HeadersInit; signal?: AbortSignal; onRevoke?: (close: () => void) => () => void;
  } = {}) =>
    handleMachineRequest(new Request(`${origin}/api/machines/${suffix}`, {
      method, headers: options.headers ?? headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    }), manager, options.onRevoke, undefined, options.readOnly ?? false, undefined, undefined, undefined, undefined, options.owner ?? true);
  return {
    send, forward, active, closed, open, manager,
    get masterClosed() { return masterClosed; },
    async [Symbol.asyncDispose]() {
      await manager.stop();
      forward.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function refusal(answer: Promise<Response>, status: number, code: string) {
  const response = await answer;
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

it("accepts only one valid port from the owning Ovis page for a connected SSH PC", async () => {
  await using f = fixture();
  for (const body of [null, {}, { port: "5173" }, { port: 1.5 }, { port: 0 }, { port: 65536 }, { port: 5173, host: "example.com" },
    ...["0.0.0.0", "[::]", "localhost", "127.0.0.999", "127.0.0.1:1234", "example.com"].map((bind) => ({ port: 5173, bind }))]) {
    await refusal(f.send("desk/forward", "POST", body), 400, "invalid_body");
  }
  await refusal(f.send("desk/forward", "POST", { port: 5173 }, { owner: false }), 403, "forbidden");
  await refusal(f.send("desk/forward", "POST", { port: 5173 }, { readOnly: true }), 403, "read_only");
  await refusal(f.send("desk/forward", "POST", { port: 5173 }, { headers: { ...headers, origin: "http://other.localhost:5173" } }), 403, "invalid_origin");
  await refusal(f.send("desk/forward", "POST", { port: 5173 }, { headers: { ...headers, "x-herdr-update": "0" } }), 403, "forbidden");
  await refusal(f.send("desk/forward", "GET"), 405, "method_not_allowed");
  await refusal(f.send("relay/forward", "POST", { port: 5173 }), 409, "forward_not_ssh");
  await refusal(f.send("local/forward", "POST", { port: 5173 }), 409, "forward_not_ssh");
  await refusal(f.send("missing/forward", "POST", { port: 5173 }), 404, "machine_not_found");
  expect(f.forward).not.toHaveBeenCalled();
});

it("reuses simultaneous and later requests, evicts the oldest at eight, and closes on disconnect", async () => {
  await using f = fixture();
  const request = async (port: number) => {
    const response = await f.send("desk/forward", "POST", { port });
    expect(response.status).toBe(200);
    return await response.json();
  };
  const [first, simultaneous] = await Promise.all([request(5173), request(5173)]);
  expect(first).toEqual(simultaneous);
  expect(await request(5173)).toEqual(first);
  expect(f.forward).toHaveBeenCalledTimes(1);
  const [local] = f.forward.mock.calls[0]!;
  expect(first).toEqual({ url: `http://127.0.0.1:${local}` });
  expect(local).not.toBe(7317);
  expect(f.forward).toHaveBeenCalledWith(local, 5173, true, "127.0.0.1");
  await Promise.all(Array.from({ length: 8 }, (_, index) => request(5174 + index)));
  expect([...f.active]).toEqual([5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181]);
  expect(f.closed).toEqual([5173]);
  expect((await f.send("desk", "PATCH", { enabled: false })).status).toBe(200);
  expect(f.masterClosed).toBe(true);
  expect(f.active.size).toBe(0);
  await refusal(f.send("desk/forward", "POST", { port: 5173 }), 503, "machine_offline");
});

it("removing a PC closes an in-flight forward without returning its address", async () => {
  await using f = fixture();
  const starting = Promise.withResolvers<void>();
  const bound = Promise.withResolvers<void>();
  f.forward.mockImplementation(async (_local, remote) => {
    starting.resolve();
    await bound.promise;
    return f.open(remote);
  });
  const answer = f.send("desk/forward", "POST", { port: 5173 });
  await starting.promise;
  expect((await f.send("desk", "DELETE")).status).toBe(200);
  bound.resolve();
  await refusal(answer, 503, "machine_offline");
  expect(f.closed).toEqual([5173]);
  expect(f.active.size).toBe(0);
});

it("a request during eviction never receives the retiring port", async () => {
  await using f = fixture();
  const evicting = Promise.withResolvers<void>();
  const finishEviction = Promise.withResolvers<void>();
  f.forward.mockImplementationOnce(async (_local, remote) => {
    const opened = f.open(remote);
    return { ...opened, close: async () => {
      evicting.resolve();
      await finishEviction.promise;
      await opened.close();
    } };
  });
  const request = (port: number) => f.send("desk/forward", "POST", { port });
  const first = await request(5173);
  expect(first.status).toBe(200);
  for (let port = 5174; port <= 5180; port++) expect((await request(port)).status).toBe(200);
  const ninth = request(5181);
  await evicting.promise;
  const repeated = request(5173);
  try {
    const early = await Promise.race([
      repeated.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    expect(early).toBe(false);
  } finally {
    finishEviction.resolve();
  }
  expect((await ninth).status).toBe(200);
  expect((await repeated).status).toBe(200);
  expect(f.forward.mock.calls.filter(([, port]) => port === 5173)).toHaveLength(2);
});

it("does not open a forward for a disconnected or revoked requester", async () => {
  await using f = fixture();
  const signal = AbortSignal.abort();
  await refusal(f.send("desk/forward", "POST", { port: 5173 }, { signal }), 499, "forward_cancelled");
  await refusal(f.send("desk/forward", "POST", { port: 5174 }, { onRevoke: (close) => { close(); return () => {}; } }), 499, "forward_cancelled");
  expect(f.forward).not.toHaveBeenCalled();
});

it("rechecks a queued request's authority after another SSH forward finishes", async () => {
  await using f = fixture();
  const binding = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.forward.mockImplementationOnce(async (_local, remote) => {
    binding.resolve();
    await finish.promise;
    return f.open(remote);
  });
  const first = f.send("desk/forward", "POST", { port: 5173 });
  await binding.promise;
  const subscribed = Promise.withResolvers<() => void>();
  const queued = f.send("desk/forward", "POST", { port: 5174 }, { onRevoke: (close) => {
    subscribed.resolve(close);
    return () => {};
  } });
  const revoke = await subscribed.promise;
  revoke();
  finish.resolve();
  expect((await first).status).toBe(200);
  await refusal(queued, 499, "forward_cancelled");
  expect(f.forward).toHaveBeenCalledTimes(1);
});

it("one waiter's abort leaves the shared opening to the others", async () => {
  await using f = fixture();
  const binding = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.forward.mockImplementationOnce(async (_local, remote) => {
    binding.resolve();
    await finish.promise;
    return f.open(remote);
  });
  // the second caller joins the pending opening synchronously inside forwardWebPort
  const joined = Promise.withResolvers<void>();
  const original = f.manager.forwardWebPort.bind(f.manager);
  let calls = 0;
  const spy = spyOn(f.manager, "forwardWebPort").mockImplementation((...args) => {
    const answer = original(...args);
    if (++calls === 2) joined.resolve();
    return answer;
  });
  try {
    const subscribed = Promise.withResolvers<() => void>();
    const aborted = f.send("desk/forward", "POST", { port: 5173 }, { onRevoke: (close) => { subscribed.resolve(close); return () => {}; } });
    await binding.promise;
    const kept = f.send("desk/forward", "POST", { port: 5173 });
    await joined.promise;
    (await subscribed.promise)();
    finish.resolve();
    await refusal(aborted, 499, "forward_cancelled");
    const response = await kept;
    expect(response.status).toBe(200);
    const [port] = f.forward.mock.calls[0]!;
    expect(await response.json()).toEqual({ url: `http://127.0.0.1:${port}` });
    expect(f.active.has(5173)).toBe(true);
    expect(f.forward).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

it("opens a separate IPv6 listener for a link that must keep its IPv6 address", async () => {
  await using f = fixture();
  const response = await f.send("desk/forward", "POST", { port: 5173, bind: "[::1]" });
  expect(response.status).toBe(200);
  const [port] = f.forward.mock.calls[0]!;
  expect(f.forward).toHaveBeenCalledWith(port, 5173, true, "[::1]");
  expect(await response.json()).toEqual({ url: `http://[::1]:${port}` });
});
