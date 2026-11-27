import { afterEach, expect, test } from "bun:test";
import { startBunRelay } from "../../relay/bun.ts";
import { signRelayPass } from "../../shared/relay-pass.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, deferred, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_SERVICE, FROM, INTO, movePc, reopen } from "./account-move.test-helpers.ts";

const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function setup() {
  let loseAnswer = false;
  const fx = await movePc({ accountFetch: async (req, fake) => {
    const response = await fake.fetch(req);
    if (loseAnswer && new URL(req.url).pathname === "/v1/pc/transfer" && response.ok) return new Response(null, { status: 503 });
    return response;
  } });
  closes.push(() => fx.pc.close());
  await fx.pc.app.stop();
  const allow = { async limit() { return { success: true }; } };
  const relay = startBunRelay({ port: 0, limiters: { perAddress: allow, global: allow } });
  closes.push(() => relay.stop());
  const origin = `wss://127.0.0.1:${relay.port}`;
  const pair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  const clock = new TestClock();
  clock.advance(Date.now());
  const linkClock = new TestClock();
  let linkNow = Date.now();
  const issueTime = Math.floor(Date.now() / 1000);
  const asked: string[] = [];
  const renewed = deferred<void>();
  const scheduledRetry = deferred<void>();
  const renewedAfterFlip = deferred<void>();
  const wroteA = deferred<void>();
  const signedIn = deferred<void>();
  let connections = 0;
  let renewalCount = 0;
  const relayOptions = {
    stateDir: fx.pc.stateDir, relay: origin, regionalRelays: [], accountService: ACCOUNT_SERVICE, ovisRelays: [origin],
    clock: { now: () => linkNow, setTimeout: (callback: () => void, ms: number) => linkClock.setTimeout(callback, ms) },
    passClock: { now: () => clock.now(), setTimeout(callback: () => void, ms: number) {
      if (ms === 30 * 60_000) scheduledRetry.resolve();
      if (ms === 60_000 && asked.at(-1) === INTO) wroteA.resolve();
      return clock.setTimeout(callback, ms);
    } },
    accountFetch: async (req: Request) => {
      if (new URL(req.url).pathname !== "/v1/pc/relay-pass") return fx.pc.account.fetch(req);
      const { account, server_id } = await req.json();
      asked.push(account);
      if (account === FROM && loseAnswer) return Response.json({ error: { code: "not_listed" } }, { status: 403 });
      return Response.json({ pass: await signRelayPass(pair.privateKey, "0badc0de", server_id, issueTime + asked.length), expires_in: 3600, refresh_in: 60 });
    },
    connect: (url: string, headers?: Record<string, string>) => {
      const target = new URL(url);
      const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`, headers ? { headers } as unknown as string[] : undefined);
      if (target.pathname === "/v1/ws" && !target.searchParams.has("connection_id") && !target.searchParams.has("warm")) {
        connections++;
        const send = socket.send.bind(socket);
        socket.send = data => {
          if (typeof data === "string" && data.includes('"relay_pass"')) {
            if (++renewalCount === 1) renewed.resolve();
            else renewedAfterFlip.resolve();
          }
          send(data);
        };
        socket.addEventListener("message", event => {
          if (typeof event.data === "string" && event.data.includes('"sync"')) signedIn.resolve();
        });
      }
      return socket;
    },
  };
  const start = async (fresh = false) => {
    const service = new RelayService(relayOptions);
    const app = reopen(fx.pc, { relay: service, accountService: { url: ACCOUNT_SERVICE, fetch: async req => {
      const response = await fx.pc.account.fetch(req);
      if (!fresh && loseAnswer && new URL(req.url).pathname === "/v1/pc/transfer" && response.ok) return new Response(null, { status: 503 });
      return response;
    } } });
    closes.push(async () => { await service.shutdown(); await app.stop(); });
    const base = `http://127.0.0.1:${app.port}`;
    expect((await fetch(`${base}/api/relay/start`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } })).ok).toBe(true);
    clock.advance(0);
    const order = () => {
      return fetch(`${base}/api/account/move`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" }, body: JSON.stringify(fx.body) });
    };
    return { app, service, order };
  };
  return { start, asked, clock, passGap: () => { linkNow += 65_000; }, renewed, renewedAfterFlip, wroteA, scheduledRetry, signedIn,
    connections: () => connections, loseAnswer: () => { loseAnswer = true; } };
}

test("a B renewal denied while a move is pending keeps the pass; the A pass renews the open socket", async () => {
  const f = await setup();
  const { app, service, order } = await f.start();
  await bounded(f.signedIn.promise);
  await bounded(f.renewed.promise);
  f.passGap();
  expect(f.asked).toEqual([FROM]);
  f.loseAnswer();
  expect((await order()).status).toBe(202);
  f.clock.advance(60_000);
  await bounded(f.scheduledRetry.promise);
  expect(service.status().pass?.state).toBe("ok");
  expect(f.asked).toEqual([FROM, FROM]);
  app.context.services.accountMove?.resume();
  await app.context.services.accountMove?.idle();
  await bounded(f.wroteA.promise);
  await bounded(f.renewedAfterFlip.promise).catch(error => { throw new Error(`A renewal did not reach the socket; accounts: ${f.asked.join(",")}`, { cause: error }); });
  expect(f.asked).toEqual([FROM, FROM, INTO]);
  expect(f.connections()).toBe(1);
});

test("a PC restarted after the switch asks for its next relay pass under A", async () => {
  const f = await setup();
  const { app, service, order } = await f.start(true);
  await bounded(f.signedIn.promise);
  await bounded(f.renewed.promise);
  f.passGap();
  expect((await order()).status).toBe(200);
  await bounded(f.wroteA.promise);
  await bounded(f.renewedAfterFlip.promise).catch(error => { throw new Error(`A renewal did not reach the socket; accounts: ${f.asked.join(",")}`, { cause: error }); });
  await service.shutdown();
  await app.stop();
  // Boot with a due renewal; there is no need to wait for the wall-clock interval.
  f.clock.advance(60_000);
  const delivered = deferred<void>();
  // Account chosen by the pass request is independently observed at the account service; the clock is deterministic.
  const { privateStateFs } = await import("../private-state.ts");
  const save = privateStateFs.renameSync;
  privateStateFs.renameSync = (from, to) => {
    save(from, to);
    if (String(to).endsWith("pass.json")) delivered.resolve();
  };
  try {
    const next = await f.start(true);
    await bounded(delivered.promise);
    expect(f.asked).toEqual([FROM, INTO, INTO]);
    expect(next.service.status().pass?.state).toBe("ok");
  } finally { privateStateFs.renameSync = save; }
});
