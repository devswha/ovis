import { describe, expect, it } from "bun:test";

import type { PhoneToPiFrame, PiToPhoneFrame } from "../../shared/pi-voice.ts";
import { BrowserLiveMedia, type PiVoiceMediaDeps } from "./piVoiceMedia.ts";

/** The browser's media objects, as much of them as the call touches. */
class FakeTrack {
  enabled = true;
  stopped = false;
  kind = "audio";
  onended: (() => void) | null = null;
  stop(): void { this.stopped = true; }
}

class FakeChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly label: string) {}
  open(): void { this.readyState = "open"; this.onopen?.(); }
  close(): void { this.readyState = "closed"; }
}

class FakePeer {
  channel: FakeChannel | undefined;
  tracks: FakeTrack[] = [];
  localDescription: { sdp: string } | null = null;
  remote: { type: string; sdp: string } | undefined;
  closed = false;
  connectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  addTrack(track: FakeTrack): void { this.tracks.push(track); }
  createDataChannel(label: string): FakeChannel { this.channel = new FakeChannel(label); return this.channel; }
  async createOffer(): Promise<{ type: string; sdp: string }> { return { type: "offer", sdp: "v=0 offer" }; }
  async setLocalDescription(description: { sdp: string }): Promise<void> { this.localDescription = description; }
  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> { this.remote = description; }
  getReceivers(): unknown[] { return []; }
  close(): void { this.closed = true; }
  fail(): void { this.connectionState = "failed"; this.onconnectionstatechange?.(); }
}

function manualTimers() {
  let now = 0;
  const timers = new Set<{ run: () => void; at: number; every: number | null }>();
  return {
    every(run: () => void, ms: number) {
      const timer = { run, at: now + ms, every: ms };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    after(run: () => void, ms: number) {
      const timer = { run, at: now + ms, every: null };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every === null) timers.delete(due);
        else due.at += due.every;
        due.run();
      }
      now = end;
    },
  };
}

function setup() {
  const track = new FakeTrack();
  const peers: FakePeer[] = [];
  const sent: PhoneToPiFrame[] = [];
  const failures: string[] = [];
  const timers = manualTimers();
  const audio = { srcObject: null as unknown, played: 0, removed: false, play() { audio.played += 1; return Promise.resolve(); }, pause() {}, remove() { audio.removed = true; } };
  const deps: PiVoiceMediaDeps = {
    stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream,
    audio: audio as unknown as HTMLAudioElement,
    audioContext: null,
    createPeer: () => { const peer = new FakePeer(); peers.push(peer); return peer as unknown as RTCPeerConnection; },
    send: (frame) => { sent.push(frame); },
    onFailed: (message) => { failures.push(message); },
    timers,
  };
  const media = new BrowserLiveMedia(deps);
  const receive = (frame: PiToPhoneFrame) => media.receive(frame);
  /** the frames sent since the last call */
  const drain = () => sent.splice(0);
  return { media, receive, drain, sent, track, peers, failures, timers, audio };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the phone as Pi's audio device", () => {
  it("says hello when the connection is up, naming the features it takes", () => {
    const { media, drain } = setup();
    media.hello();
    expect(drain()).toEqual([{ type: "hello", features: ["park", "usage"] }]);
  });

  it("opens at once, since the microphone is already held", async () => {
    const { receive, drain } = setup();
    receive({ type: "request", id: 1, method: "open" });
    await flush();
    expect(drain()).toEqual([{ type: "response", id: 1, ok: true }]);
  });

  it("makes the offer with the oai-events channel and a microphone that is not yet sending", async () => {
    const { receive, drain, peers, track } = setup();
    receive({ type: "request", id: 2, method: "createOffer" });
    await flush();
    expect(drain()).toEqual([{ type: "response", id: 2, ok: true, sdp: "v=0 offer" }]);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.channel?.label).toBe("oai-events");
    expect(peers[0]!.tracks).toEqual([track]);
    expect(track.enabled).toBe(false);
  });

  it("takes the answer and waits for the channel to open", async () => {
    const { receive, drain, peers } = setup();
    receive({ type: "request", id: 1, method: "createOffer" });
    await flush();
    drain();
    receive({ type: "request", id: 2, method: "acceptAnswer", sdp: "v=0 answer" });
    await flush();
    expect(peers[0]!.remote).toEqual({ type: "answer", sdp: "v=0 answer" });
    expect(drain()).toEqual([{ type: "response", id: 2, ok: true }]);
    receive({ type: "request", id: 3, method: "waitForOpen" });
    await flush();
    expect(drain()).toEqual([]);
    peers[0]!.channel!.open();
    await flush();
    expect(drain()).toEqual([{ type: "response", id: 3, ok: true }]);
  });

  it("answers a wait for an open channel that never comes with an error", async () => {
    const { receive, drain, timers } = setup();
    receive({ type: "request", id: 1, method: "createOffer" });
    await flush();
    drain();
    receive({ type: "request", id: 2, method: "waitForOpen", timeoutMs: 3000 });
    await flush();
    timers.advance(3000);
    await flush();
    expect(drain()).toEqual([{ type: "response", id: 2, ok: false, error: "The connection to the voice service did not open." }]);
  });

  it("refuses a request it cannot serve instead of staying silent", async () => {
    const { receive, drain } = setup();
    receive({ type: "request", id: 4, method: "acceptAnswer", sdp: "v=0 answer" });
    await flush();
    const [answer] = drain();
    expect(answer).toMatchObject({ type: "response", id: 4, ok: false });
  });

  it("sends the microphone from activate on, unless muted", async () => {
    const { receive, track } = setup();
    receive({ type: "request", id: 1, method: "createOffer" });
    await flush();
    receive({ type: "mute", muted: true });
    receive({ type: "activate" });
    expect(track.enabled).toBe(false);
    receive({ type: "mute", muted: false });
    expect(track.enabled).toBe(true);
    receive({ type: "mute", muted: true });
    expect(track.enabled).toBe(false);
  });

  it("sends levels only once the call is active, and the server's events as they come", async () => {
    const { receive, drain, peers, timers } = setup();
    receive({ type: "request", id: 1, method: "createOffer" });
    await flush();
    drain();
    timers.advance(500);
    expect(drain().filter((frame) => frame.type === "levels")).toEqual([]);
    receive({ type: "activate" });
    timers.advance(300);
    const levels = drain().filter((frame) => frame.type === "levels");
    expect(levels.length).toBeGreaterThanOrEqual(2);
    for (const frame of levels) {
      expect(frame.input).toBeGreaterThanOrEqual(0);
      expect(frame.output).toBeLessThanOrEqual(1);
    }
    peers[0]!.channel!.onmessage?.({ data: '{"type":"session.started"}' });
    peers[0]!.channel!.onmessage?.({ data: new ArrayBuffer(4) });
    expect(drain().filter((frame) => frame.type === "event")).toEqual([{ type: "event", payload: '{"type":"session.started"}' }]);
  });

  it("gives up, saying so, when Pi has been silent for the lease, and a ping keeps it", async () => {
    const { media, receive, drain, track, peers, failures, timers } = setup();
    media.hello();
    receive({ type: "request", id: 1, method: "createOffer" });
    await flush();
    drain();
    timers.advance(15_000);
    receive({ type: "ping" });
    timers.advance(15_000);
    expect(failures).toEqual([]);
    timers.advance(6_000);
    expect(drain()).toEqual([{ type: "failure", message: "Pi stopped answering." }]);
    expect(failures).toEqual(["Pi stopped answering."]);
    expect(track.stopped).toBe(true);
    expect(peers[0]!.closed).toBe(true);
  });

  it("fails when the peer connection fails", async () => {
    const { receive, drain, peers, failures } = setup();
    receive({ type: "request", id: 1, method: "createOffer" });
    await flush();
    drain();
    peers[0]!.fail();
    expect(drain()).toEqual([{ type: "failure", message: "The connection to the voice service failed." }]);
    expect(failures).toHaveLength(1);
  });

  it("says nothing once it is closed: a wait still pending when the call ends is dropped, not answered later", async () => {
    const { media, receive, drain, peers, timers } = setup();
    receive({ type: "request", id: 1, method: "createOffer" });
    await flush();
    receive({ type: "request", id: 2, method: "waitForOpen", timeoutMs: 3000 });
    await flush();
    drain();
    media.close();
    timers.advance(10_000);
    peers[0]!.channel!.open();
    await flush();
    // a response sent now would reach whichever call the sender points at by then, and Pi ends a call for an unasked one
    expect(drain()).toEqual([]);
  });

  it("does not answer a request that was still being served when the call closed", async () => {
    const { media, receive, drain } = setup();
    receive({ type: "request", id: 1, method: "createOffer" });
    media.close();
    await flush();
    expect(drain()).toEqual([]);
  });

  it("stops the microphone, the peer and the speaker on close, without calling it a failure", async () => {
    const { receive, drain, track, peers, failures, audio } = setup();
    receive({ type: "request", id: 1, method: "createOffer" });
    await flush();
    drain();
    receive({ type: "close" });
    expect(track.stopped).toBe(true);
    expect(peers[0]!.closed).toBe(true);
    expect(audio.srcObject).toBeNull();
    expect(drain()).toEqual([]);
    expect(failures).toEqual([]);
  });
  describe("parking", () => {
    /** a call that is up and active, as Pi parks it */
    async function active() {
      const harness = setup();
      harness.receive({ type: "request", id: 1, method: "createOffer" });
      await flush();
      harness.receive({ type: "request", id: 2, method: "acceptAnswer", sdp: "v=0 answer" });
      harness.receive({ type: "request", id: 3, method: "waitForOpen" });
      harness.peers[0]!.channel!.open();
      await flush();
      harness.receive({ type: "activate" });
      harness.timers.advance(200);
      harness.drain();
      return harness;
    }

    it("lets go of the connection to the voice service and keeps the microphone, the speaker and Pi", async () => {
      const { receive, drain, track, peers, audio, failures, timers } = await active();
      receive({ type: "park" });
      expect(peers[0]!.closed).toBe(true);
      expect(peers[0]!.channel!.readyState).toBe("closed");
      expect(audio.srcObject).toBeNull();
      expect(track.stopped).toBe(false);
      expect(audio.removed).toBe(false);
      // nothing is sent while parked: not the microphone, not the levels
      expect(track.enabled).toBe(false);
      timers.advance(1000);
      expect(drain()).toEqual([]);
      // the peer going away is not a failure, nor is a late event from it passed on
      peers[0]!.fail();
      peers[0]!.channel!.onmessage?.({ data: '{"type":"late"}' });
      expect(drain()).toEqual([]);
      expect(failures).toEqual([]);
    });

    it("answers a wait for the channel that parking cuts short with an error, not silence", async () => {
      const { receive, drain } = setup();
      receive({ type: "request", id: 1, method: "createOffer" });
      await flush();
      receive({ type: "request", id: 2, method: "waitForOpen", timeoutMs: 30_000 });
      await flush();
      drain();
      receive({ type: "park" });
      await flush();
      expect(drain()).toEqual([{ type: "response", id: 2, ok: false, error: "The call is parked." }]);
    });

    it("makes a new offer on the same media when Pi resumes it, and is active again from activate", async () => {
      const { receive, drain, track, peers, timers } = await active();
      receive({ type: "park" });
      receive({ type: "request", id: 5, method: "createOffer" });
      await flush();
      expect(drain()).toEqual([{ type: "response", id: 5, ok: true, sdp: "v=0 offer" }]);
      expect(peers).toHaveLength(2);
      expect(peers[1]!.tracks).toEqual([track]);
      expect(peers[1]!.channel?.label).toBe("oai-events");
      receive({ type: "request", id: 6, method: "acceptAnswer", sdp: "v=0 answer 2" });
      receive({ type: "request", id: 7, method: "waitForOpen" });
      await flush();
      expect(peers[1]!.remote).toEqual({ type: "answer", sdp: "v=0 answer 2" });
      peers[1]!.channel!.open();
      await flush();
      expect(drain()).toEqual([{ type: "response", id: 6, ok: true }, { type: "response", id: 7, ok: true }]);
      // still parked until Pi says activate again: the microphone stays shut and no levels go out
      expect(track.enabled).toBe(false);
      timers.advance(300);
      expect(drain()).toEqual([]);
      receive({ type: "activate" });
      expect(track.enabled).toBe(true);
      timers.advance(300);
      expect(drain().filter((frame) => frame.type === "levels").length).toBeGreaterThanOrEqual(2);
      peers[1]!.channel!.onmessage?.({ data: '{"type":"session.started"}' });
      expect(drain()).toEqual([{ type: "event", payload: '{"type":"session.started"}' }]);
    });

    it("keeps its mute through a park", async () => {
      const { receive, track } = await active();
      receive({ type: "mute", muted: true });
      receive({ type: "park" });
      receive({ type: "request", id: 5, method: "createOffer" });
      await flush();
      receive({ type: "activate" });
      expect(track.enabled).toBe(false);
    });

    it("still gives up on a Pi that stops answering while parked, and a ping keeps it", async () => {
      const { media, receive, drain, track, failures, timers } = await active();
      media.hello();
      drain();
      receive({ type: "park" });
      timers.advance(15_000);
      receive({ type: "ping" });
      timers.advance(15_000);
      expect(failures).toEqual([]);
      timers.advance(6_000);
      expect(failures).toEqual(["Pi stopped answering."]);
      expect(track.stopped).toBe(true);
    });
  });
});
