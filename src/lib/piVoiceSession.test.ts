import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { ENDED_SHOWN_MS, endPiVoice, formatPiVoiceTime, piVoiceState, resumePiVoice, startPiVoice } from "./piVoiceSession.ts";

/** What the call touches of the browser: a microphone whose permission prompt the test settles, and sockets it can drive. */
class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(text: string): void { this.sent.push(text); }
  close(): void { this.closed = true; }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(frame: object): void { this.onmessage?.({ data: JSON.stringify({ v: 1, ...frame }) }); }
}

const originals = new Map<string, PropertyDescriptor | undefined>();
function stub(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

let tracks: { stopped: boolean; enabled: boolean; stop(): void }[] = [];
let grant: (() => void) | undefined;
let deny: (() => void) | undefined;

beforeEach(() => {
  FakeSocket.all = [];
  tracks = [];
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  };
  stub("WebSocket", FakeSocket);
  stub("RTCPeerConnection", class {});
  stub("Audio", class { autoplay = false; play() { return Promise.resolve(); } pause() {} remove() {} });
  stub("window", { location: { protocol: "https:", host: "ovis.test" } });
  stub("document", { visibilityState: "hidden", addEventListener() {}, removeEventListener() {} });
  stub("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve, reject) => {
          grant = () => {
            tracks.push({ stopped: false, enabled: true, stop() { this.stopped = true; } });
            resolve(stream);
          };
          deny = () => reject(new DOMException("Permission denied", "NotAllowedError"));
        }),
    },
  });
});

afterEach(() => {
  endPiVoice();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  originals.clear();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("starting a call from the phone", () => {
  it("opens the connection only once the microphone is allowed, and listens to it from its first frame", async () => {
    startPiVoice({ machineId: "local", paneId: "w1:p1", label: "cwd" });
    // the permission prompt can stay open for as long as the user likes: Pi may give up meanwhile
    expect(FakeSocket.all).toHaveLength(0);
    grant?.();
    await flush();
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.url).toBe("wss://ovis.test/ws/pi-voice?pane_id=w1%3Ap1");
    const socket = FakeSocket.all[0]!;
    socket.open();
    expect(socket.sent.map((text) => JSON.parse(text).type)).toEqual(["hello"]);
    // Pi's answer to a start it cannot take arrives with nothing else in between
    socket.receive({ type: "ready", pid: 1, busy: false });
    socket.receive({ type: "ended", error: "Live voice is already on in this Pi." });
    expect(piVoiceState()).toMatchObject({ status: "ended", end: { kind: "error", message: "Live voice is already on in this Pi." } });
    expect(socket.closed).toBe(true);
    // the microphone goes quiet at once, and is let go once the close chime has played
    expect(tracks.every((track) => !track.enabled && !track.stopped)).toBe(true);
    const deadline = Date.now() + 5_000;
    while (!tracks.every((track) => track.stopped)) {
      if (Date.now() > deadline) throw new Error("the microphone was never let go");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  it("names the PC of a pane on another one, so this server calls through to it", async () => {
    startPiVoice({ machineId: "mac mini", paneId: "w1:p1", label: "cwd", voice: "vale" });
    grant?.();
    await flush();
    expect(FakeSocket.all[0]!.url).toBe("wss://ovis.test/ws/pi-voice?pane_id=w1%3Ap1&machine_id=mac%20mini&voice=vale");
    expect(piVoiceState()).toMatchObject({ machineId: "mac mini", paneId: "w1:p1" });
  });

  it("opens nothing when the microphone is refused", async () => {
    startPiVoice({ machineId: "local", paneId: "w1:p1", label: "cwd" });
    deny?.();
    await flush();
    expect(piVoiceState()).toMatchObject({ status: "ended", end: { kind: "denied" } });
    expect(FakeSocket.all).toHaveLength(0);
    // End puts the orb away
    endPiVoice();
    expect(piVoiceState()).toMatchObject({ status: "idle", end: null });
  });

  it("lets go of a microphone that is allowed after the call was ended", async () => {
    startPiVoice({ machineId: "local", paneId: "w1:p1", label: "cwd" });
    endPiVoice();
    grant?.();
    await flush();
    expect(piVoiceState().status).toBe("idle");
    expect(tracks.every((track) => track.stopped)).toBe(true);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

async function liveOn(paneId: string): Promise<FakeSocket> {
  startPiVoice({ machineId: "local", paneId, label: "cwd" });
  grant?.();
  await flush();
  const socket = FakeSocket.all.at(-1)!;
  socket.open();
  socket.receive({ type: "phase", phase: "listening" });
  return socket;
}

describe("a call that ended", () => {
  it("shows why for a moment on the pane it was on, then puts the orb away", async () => {
    const socket = await liveOn("w1:p1");
    jest.useFakeTimers();
    try {
      socket.receive({ type: "ended", code: "closed" });
      expect(piVoiceState()).toMatchObject({ status: "ended", paneId: "w1:p1", label: "cwd", end: { kind: "closed" } });
      jest.advanceTimersByTime(ENDED_SHOWN_MS - 1);
      expect(piVoiceState().status).toBe("ended");
      jest.advanceTimersByTime(1);
      expect(piVoiceState()).toMatchObject({ status: "idle", end: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not cut a call started in the meantime short", async () => {
    const socket = await liveOn("w1:p1");
    jest.useFakeTimers();
    try {
      socket.receive({ type: "ended", code: "closed" });
      startPiVoice({ machineId: "local", paneId: "w1:p2", label: "cwd" });
      jest.advanceTimersByTime(ENDED_SHOWN_MS);
      expect(piVoiceState()).toMatchObject({ status: "starting", paneId: "w1:p2" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("goes quietly when it was Pi's own end or the tap on End", async () => {
    const socket = await liveOn("w1:p1");
    socket.receive({ type: "ended" });
    expect(piVoiceState().status).toBe("idle");
    await liveOn("w1:p1");
    endPiVoice();
    expect(piVoiceState().status).toBe("idle");
  });
});

describe("a parked call", () => {
  const sentTypes = (socket: FakeSocket) => socket.sent.map((text) => JSON.parse(text).type as string);

  it("stays live while Pi parks it, and resumes when the orb is tapped", async () => {
    const socket = await liveOn("w1:p1");
    socket.receive({ type: "phase", phase: "parked" });
    expect(piVoiceState()).toMatchObject({ status: "live", phase: "parked", paneId: "w1:p1" });
    socket.sent.length = 0;
    resumePiVoice();
    expect(sentTypes(socket)).toEqual(["resume"]);
    // the tap answers at once; Pi's own phases take over from there
    expect(piVoiceState().phase).toBe("connecting");
    resumePiVoice();
    expect(sentTypes(socket)).toEqual(["resume"]);
    socket.receive({ type: "phase", phase: "listening" });
    expect(piVoiceState().phase).toBe("listening");
  });

  it("asks Pi for nothing when the call is not parked", async () => {
    const socket = await liveOn("w1:p1");
    socket.sent.length = 0;
    resumePiVoice();
    expect(socket.sent).toEqual([]);
    expect(piVoiceState().phase).toBe("listening");
  });
});

describe("the call's billed time", () => {
  it("shows Pi's seconds, and none before the first or after the call", async () => {
    const socket = await liveOn("w1:p1");
    expect(piVoiceState().usage).toBeNull();
    socket.receive({ type: "usage", seconds: 75 });
    expect(piVoiceState().usage).toBe(75);
    socket.receive({ type: "usage", seconds: 76 });
    expect(piVoiceState().usage).toBe(76);
    socket.receive({ type: "ended", code: "closed" });
    expect(piVoiceState().usage).toBeNull();
  });

  it("reads as minutes and seconds", () => {
    expect([0, 5, 59, 60, 75, 600, 3725].map(formatPiVoiceTime)).toEqual(["0:00", "0:05", "0:59", "1:00", "1:15", "10:00", "62:05"]);
  });
});
