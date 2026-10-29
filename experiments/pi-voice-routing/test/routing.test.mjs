import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTargets, Routing } from "../src/routing.mjs";
import { fakeEndpoint, FAKE_TARGET } from "../src/fake.mjs";
import { printable } from "../src/main.mjs";

async function fixture() {
  const observer = fakeEndpoint();
  await observer.connect();
  const humans = [];
  const replies = [];
  const routing = new Routing(observer, () => {
    const human = fakeEndpoint();
    humans.push(human);
    return human;
  }, (event) => replies.push(event.text));
  const select = () => routing.select(FAKE_TARGET.id, FAKE_TARGET.endpointEpoch);
  return { observer, humans, routing, replies, select };
}

test("only live exact agent endpoints are candidates", () => {
  assert.deepEqual(agentTargets([
    FAKE_TARGET, { ...FAKE_TARGET, kind: "human" }, { ...FAKE_TARGET, ready: false },
    { ...FAKE_TARGET, endpointEpoch: "" }, { ...FAKE_TARGET, id: undefined },
  ]), [FAKE_TARGET]);
});

test("explicit select/send/reply/end; end does not imply cancellation", async () => {
  const f = await fixture();
  await assert.rejects(f.routing.send("not selected"));
  await f.select();
  assert.deepEqual(await f.routing.send("hello"), { delivery: "socket_delivered", outcomeKnown: true });
  assert.deepEqual(f.replies, ["Fake reply: hello"]);
  await f.routing.end();
  await assert.rejects(f.routing.send("after end"));
});

test("no names, prefixes, stale epochs or duplicate identities", async () => {
  const f = await fixture();
  await assert.rejects(f.routing.select("Example Pi", FAKE_TARGET.endpointEpoch));
  await assert.rejects(f.routing.select(FAKE_TARGET.id, "old"));
  f.observer.listSessions = async () => [FAKE_TARGET, FAKE_TARGET];
  await assert.rejects(f.select());
  assert.equal(f.humans.length, 0);
});

test("a replaced target cannot receive; send rechecks the fresh roster", async () => {
  const f = await fixture();
  await f.select();
  f.observer.listSessions = async () => [{ ...FAKE_TARGET, endpointEpoch: "replacement" }];
  let sends = 0;
  f.humans[0].sendExact = async () => { sends++; };
  await assert.rejects(f.routing.send("blocked"));
  assert.equal(sends, 0);
  assert.equal(f.humans[0].connected, false);
});

test("unknown outcome or transport throw blocks subsequent sends without retry", async () => {
  for (const throws of [false, true]) {
    const f = await fixture();
    await f.select();
    let sends = 0;
    f.humans[0].sendExact = async () => {
      sends++;
      if (throws) throw new Error("socket failed");
      return { delivery: "unknown", outcomeKnown: false };
    };
    if (throws) await assert.rejects(f.routing.send("once"), /unknown/);
    else assert.equal((await f.routing.send("once")).outcomeKnown, false);
    await assert.rejects(f.routing.send("twice"));
    assert.equal(sends, 1);
    await f.routing.end();
    await f.select();
    assert.notEqual(f.humans[0], f.humans[1]);
    await f.routing.end();
  }
});

test("end fences pending send preflight and late or wrong-sender replies", async () => {
  const f = await fixture();
  const handlers = [];
  const original = f.routing;
  await original.end();
  const human = fakeEndpoint();
  human.onMessage = (handler) => { handlers.push(handler); };
  const routing = new Routing(f.observer, () => human, (event) => f.replies.push(event.text));
  await routing.select(FAKE_TARGET.id, FAKE_TARGET.endpointEpoch);
  handlers[0]({ ...FAKE_TARGET, endpointEpoch: "other" }, { content: { text: "wrong" } });
  let resolve;
  f.observer.listSessions = () => new Promise((done) => { resolve = done; });
  const sending = routing.send("race");
  await routing.end();
  resolve([FAKE_TARGET]);
  await assert.rejects(sending);
  handlers[0](FAKE_TARGET, { content: { text: "late" } });
  assert.deepEqual(f.replies, []);
});

test("observer disconnection fences human endpoint", async () => {
  const f = await fixture();
  await f.select();
  await f.observer.disconnect();
  assert.equal(f.humans[0].connected, false);
  await assert.rejects(f.routing.send("blocked"));
});

test("concurrent selections cannot both acquire authority", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.select(), f.select()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.humans.length, 1);
  await f.routing.end();
});

test("blank and oversized text is rejected before dispatch", async () => {
  const f = await fixture();
  await f.select();
  await assert.rejects(f.routing.send(" "));
  await assert.rejects(f.routing.send("x".repeat(16385)));
  await f.routing.end();
});

test("terminal output strips escape and control sequences and is bounded", () => {
  assert.equal(printable("\x1b[31mred\x1b[0m\n\x07"), "red  ");
  assert.ok(printable("x".repeat(40000)).length <= 32768);
});
