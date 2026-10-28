import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { type Client, connectionData } from "./connections.ts";
import { createInputLane } from "./input.ts";

afterEach(() => mock.restore());

/** long enough that a key sent without waiting (a few ms) cannot pass for one that waited */
const KEY_SETTLE_MS = 120;
const TYPED_SETTLE_MS = 240;

/**
 * One connection attached and ready on pane w:p1, its pty writes and herdr's RPCs written down with
 * the time they were made. A key goes through herdr around the pty, so the lane is what keeps it
 * from overtaking the typing before it: herdr offers no barrier for bytes in the attach pty (#634).
 */
function lane() {
  const events: Array<{ what: string; at: number }> = [];
  const socket = { data: connectionData({ deviceId: undefined, readOnly: false }), send: () => 1, getBufferedAmount: () => 0, close: () => {} } as unknown as Client;
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  const sighting = { origin: "attach", pty: "pty", claim: "claim", facts: () => facts, write: (data: string) => { events.push({ what: `pty ${JSON.stringify(data)}`, at: Date.now() }); return true; } };
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane, keys, _socketPath, guard) => {
    if (guard && !guard()) throw new client.HerdrError("cancelled", "not sent");
    events.push({ what: `keys ${keys.join(",")}`, at: Date.now() });
  });
  spyOn(client, "paneSendText").mockImplementation(async (_pane, text, _socketPath, guard) => {
    if (guard && !guard()) throw new client.HerdrError("cancelled", "not sent");
    events.push({ what: `text ${JSON.stringify(text)}`, at: Date.now() });
  });
  const { inputFrames } = createInputLane({
    TYPED_SETTLE_MS, KEY_SETTLE_MS, clients: new Set([socket]), sight: () => sighting, poke: () => {},
    terminalAttach: async () => false, terminalAttachKnown: () => true, mayType: () => true, authorizeSocket: () => {},
  });
  return {
    events,
    type: (text: string) => inputFrames.input(socket, { type: "input", pane_id: "w:p1", text }),
    keys: (keys: string[]) => inputFrames.keys(socket, { type: "keys", pane_id: "w:p1", keys }),
    gap: (from: string, to: string) => events.find((e) => e.what === to)!.at - events.find((e) => e.what === from)!.at,
  };
}

it("sends a key KEY_SETTLE_MS after the letter typed into the pty before it", async () => {
  const { events, type, keys, gap } = lane();
  type("a");
  await keys(["left"]);
  expect(events.map((e) => e.what)).toEqual(["pty \"a\"", "keys left"]);
  // timers count whole milliseconds: one may fire up to a millisecond before Date.now() says it is due
  expect(gap("pty \"a\"", "keys left")).toBeGreaterThanOrEqual(KEY_SETTLE_MS - 1);
});

it("sends a key TYPED_SETTLE_MS after typing that ended in an ESC, which herdr holds a moment", async () => {
  const { events, type, keys, gap } = lane();
  type("\x1b");
  await keys(["up"]);
  expect(events.map((e) => e.what)).toEqual(["pty \"\\u001b\"", "keys up"]);
  expect(gap("pty \"\\u001b\"", "keys up")).toBeGreaterThanOrEqual(TYPED_SETTLE_MS - 1);
});

it("types a letter that comes while a key waits after the key, through herdr, not into the pty", async () => {
  const { events, type, keys } = lane();
  type("a");
  const sent = keys(["left"]);
  type("b");
  await sent;
  // the letter's turn comes right after the key's: wait for that turn to be taken
  await keys(["right"]);
  expect(events.map((e) => e.what)).toEqual(["pty \"a\"", "keys left", "text \"b\"", "keys right"]);
});
