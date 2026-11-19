import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceNotice, NoticeAnswer, NoticeSeen } from "../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { useDeviceNotices, type NoticeSocket } from "./useDeviceNotices.ts";

const notice = (seq: number, open = true): DeviceNotice => ({
  seq, id: seq.toString(16).padStart(32, "0"), at: "2026-11-20T04:00:00.000Z", kind: open ? "admit" : "method", how: "list", key: "k".repeat(43), no: 4,
  row: "r1", label: "Galaxy S30", by: null, account: "acct", open, method: "github", two_step: "set",
});

class FakeSocket implements NoticeSocket {
  readonly sent: (NoticeSeen | NoticeAnswer)[] = [];
  offers = true;
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  on(handler: (message: ServerMessage) => void) { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; }
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
    seen = useDeviceNotices(sockets);
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
