import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceNotice, NoticeAnswer, NoticeSeen } from "../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { DEVICE_NOTICE_FEATURE, DeviceNoticeWire, deviceNotice } from "./deviceNoticeWire.fixture.ts";
import { useDeviceNotices, type NoticeSocket } from "./useDeviceNotices.ts";
import { HerdrSocket } from "./ws.ts";

const notice = (seq: number, open = true): DeviceNotice => ({
  seq, id: seq.toString(16).padStart(32, "0"), at: "2026-11-20T04:00:00.000Z", kind: open ? "admit" : "method", how: "list", key: "k".repeat(43), no: 4,
  row: "r1", label: "Galaxy S30", by: null, account: "acct", open, method: "github", two_step: "set",
});

describe("device notices on the real PC socket", () => {
  let renderer: ReactTestRenderer | undefined;
  const restorations = new Map<string, PropertyDescriptor | undefined>();
  const sockets: HerdrSocket[] = [];
  let result: ReturnType<typeof useDeviceNotices> | undefined;

  function Probe({ socket }: { socket: HerdrSocket }) {
    result = useDeviceNotices([{ id: "desk", socket }], "desk");
    return null;
  }

  async function connect() {
    const wire = new DeviceNoticeWire("ws://localhost/ws");
    for (const [key, value] of Object.entries({
      window: Object.assign(new EventTarget(), { location: new URL("http://localhost/"), setTimeout, clearTimeout, setInterval, clearInterval }),
      document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
      WebSocket: class { constructor() { return wire; } },
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      restorations.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const socket = new HerdrSocket(wire.url);
    sockets.push(socket);
    await act(async () => { renderer = create(<Probe socket={socket} />); });
    socket.connect();
    wire.open();
    return { wire, socket };
  }

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    result = undefined;
    for (const socket of sockets.splice(0)) socket.close();
    for (const [key, original] of restorations) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    restorations.clear();
  });

  const cards = () => result?.byPc.get("desk")?.notices ?? [];
  const method = deviceNotice({ id: "b".repeat(32), seq: 2, kind: "method", open: false });

  it("T57, P15: a later decision replaces the open admission and makes it dismissible", async () => {
    const { wire } = await connect();
    const admission = deviceNotice({ row: "row-1" });
    const decided = { ...admission, open: false };
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice: admission }); });
    await act(async () => { wire.read({ type: "device-notice", notice: decided }); });
    expect(cards()).toEqual([decided]);
    await act(async () => { result?.dismiss("desk", decided); });
    expect(cards()).toEqual([]);
  });

  it("T57: replay cannot resurrect a dismissed method notice, and a rowless open admission stays", async () => {
    const { wire } = await connect();
    const admission = deviceNotice();
    const replay = { type: "device-notice-replay", replay: { notices: [admission, method], cut: 0 } } as const;
    await act(async () => { wire.snapshot(); wire.read(replay); });
    await act(async () => { result?.dismiss("desk", admission); result?.dismiss("desk", method); });
    expect(cards()).toEqual([admission]);
    await act(async () => { wire.read(replay); });
    expect(cards()).toEqual([admission]);
  });

  it("T57, G5: the capability snapshot acknowledges offered replay, never a subsequent dismiss", async () => {
    const { wire, socket } = await connect();
    await act(async () => {
      wire.read({ type: "features", herdr_lifetime: "new", connection: "desk-1", features: [DEVICE_NOTICE_FEATURE] });
      wire.read({ type: "device-notice-replay", replay: { notices: [deviceNotice(), method], cut: 0 } });
    });
    expect(socket.accountOpensAll()).toBe(false);
    expect(wire.seen()).toEqual([]);
    const beforeSnapshot = cards();
    await act(async () => { wire.snapshot(); });
    const afterSnapshot = [...wire.seen()];
    const beforeDismiss = [...wire.sent];
    await act(async () => { result?.dismiss("desk", method); });
    expect({ beforeSnapshot, afterSnapshot, dismissSent: wire.sent.slice(beforeDismiss.length) }).toEqual({
      beforeSnapshot: [], afterSnapshot: [{ type: "notice-seen", seq: 2 }], dismissSent: [],
    });
    expect(cards()).toEqual([deviceNotice()]);
  });

  it("G5: ignores unadvertised notice frames even if the socket later offers the feature", async () => {
    const { wire } = await connect();
    await act(async () => {
      wire.read({ type: "device-notice-replay", replay: { notices: [deviceNotice()], cut: 7 } });
      wire.snapshot([]);
      wire.read({ type: "device-notice", notice: method });
    });
    const beforeOffer = result?.byPc.has("desk");
    await act(async () => { wire.snapshot(); });
    expect({ beforeOffer, afterOffer: result?.byPc.has("desk"), acknowledged: wire.seen() }).toEqual({
      beforeOffer: false, afterOffer: false, acknowledged: [],
    });
  });

  it("G5: withdrawing the capability clears cards and ignores later frames", async () => {
    const { wire } = await connect();
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice: deviceNotice() }); });
    expect(cards()).toHaveLength(1);
    await act(async () => { wire.snapshot([]); });
    const withdrawn = cards();
    await act(async () => { wire.read({ type: "device-notice", notice: method }); wire.snapshot(); });
    expect({ withdrawn, restored: cards(), acknowledged: wire.seen() }).toEqual({
      withdrawn: [], restored: [], acknowledged: [{ type: "notice-seen", seq: 1 }],
    });
  });

  it("P15: exposes the selected PC's trimmed replay count even with no surviving cards", async () => {
    const { wire } = await connect();
    await act(async () => {
      wire.snapshot();
      wire.read({ type: "device-notice-replay", replay: { notices: [], cut: 12 } });
    });
    expect(result).toHaveProperty("cut", 12);
    await act(async () => { wire.read({ type: "device-notice", notice: method }); });
    expect(result).toHaveProperty("cut", 12);
    await act(async () => { wire.snapshot([]); });
    expect(result).toHaveProperty("cut", 0);
  });
});

class FakeSocket implements NoticeSocket {
  readonly sent: (NoticeSeen | NoticeAnswer)[] = [];
  offers = true;
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  on(handler: (message: ServerMessage) => void) { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; }
  onDisconnect() { return () => {}; }
  accountOpensAll() { return this.offers; }
  sendNotice(message: NoticeSeen | NoticeAnswer) { if (!this.offers) return false; this.sent.push(message); return true; }
  receive(message: ServerMessage) { for (const handler of this.handlers) handler(message); }
}

describe("each PC's device notices in the app", () => {
  let renderer: ReactTestRenderer | undefined;
  let seen: ReturnType<typeof useDeviceNotices> | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  beforeEach(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    if (descriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", descriptor); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  function Probe({ sockets }: { sockets: readonly { id: string; socket: NoticeSocket }[] }) {
    seen = useDeviceNotices(sockets, "desk");
    return null;
  }

  it("T57: a PC's replay shows once and is acknowledged once, up to its newest notice", async () => {
    const desk = new FakeSocket();
    await act(async () => { renderer = create(<Probe sockets={[{ id: "desk", socket: desk }]} />); });
    await act(async () => { desk.receive({ type: "device-notice-replay", replay: { notices: [notice(2), notice(3, false)], cut: 0 } }); });
    await act(async () => { desk.receive({ type: "device-notice", notice: notice(3, false) }); });
    expect(seen!.byPc.get("desk")?.notices.map((item) => item.seq)).toEqual([2, 3]);
    expect(desk.sent).toEqual([{ type: "notice-seen", seq: 3 }]);
  });

  it("T57: dismissing a told notice decides nothing on the PC, and an open admission stays", async () => {
    const desk = new FakeSocket();
    await act(async () => { renderer = create(<Probe sockets={[{ id: "desk", socket: desk }]} />); });
    await act(async () => { desk.receive({ type: "device-notice-replay", replay: { notices: [notice(2), notice(3, false)], cut: 0 } }); });
    await act(async () => { seen!.dismiss("desk", notice(3, false)); seen!.dismiss("desk", notice(2)); });
    expect(seen!.byPc.get("desk")?.notices.map((item) => item.seq)).toEqual([2]);
    expect(desk.sent.filter((message) => message.type === "notice-answer")).toEqual([]);
  });

  it("G5: a PC that does not offer it gets no acknowledgment, and is asked again once it does", async () => {
    const desk = new FakeSocket();
    desk.offers = false;
    await act(async () => { renderer = create(<Probe sockets={[{ id: "desk", socket: desk }]} />); });
    await act(async () => { desk.receive({ type: "device-notice-replay", replay: { notices: [notice(5)], cut: 0 } }); });
    expect(desk.sent).toEqual([]);
    desk.offers = true;
    await act(async () => { desk.receive({ type: "device-notice", notice: notice(6, false) }); });
    expect(desk.sent).toEqual([{ type: "notice-seen", seq: 6 }]);
  });
});
