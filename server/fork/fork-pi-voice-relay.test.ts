import { expect, test } from "bun:test";

import { PI_VOICE_PATH, PI_VOICE_STATUS_PATH, parsePiFrame } from "../../shared/pi-voice.ts";
import { FrameType } from "../../shared/relay-mux.ts";
import { RelaySession, type RelaySessionOptions } from "../relay/session.ts";
import { bounded, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { PiVoiceHub } from "./pi-voice.ts";

for (const role of ["drive", "watch"] as const) {
  test(`paired relay ${role} device ${role === "drive" ? "reaches Pi voice" : "cannot open Pi voice"}`, async () => {
    const fixture = relayFixture(false, { sidecar: true });
    const services = fixture.app.context.services;
    const calls: string[] = [];
    const piVoice = new PiVoiceHub({ candidates: async (pane) => { calls.push(pane); return null; } });
    class TestSession extends RelaySession {
      constructor(options: RelaySessionOptions) { super({ ...options, services: { ...services, piVoice } }); }
    }
    const link = await relayConnection(fixture, { websocket: services.core.socketHandlers }, TestSession);
    try {
      await link.auth(await relayDevice(fixture, role));
      const status = await link.open(`${PI_VOICE_STATUS_PATH}?pane_id=w1:p1`).response;
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ available: false, busy: false });
      expect(calls).toEqual(["w1:p1"]);
      const stream = link.mux.openWs({ target: `${PI_VOICE_PATH}?pane_id=w1:p1`, headers: [], protocols: [] });
      const result = Promise.withResolvers<unknown>();
      stream.onMessage = (data) => result.resolve(parsePiFrame(String(data)));
      link.onFrame = (frame) => {
        if (frame.type === FrameType.HTTP_HEADERS && frame.stream_id === stream.id) result.resolve(frame.payload.status);
      };
      stream.onClose = (event) => result.reject(new Error(`Socket closed: ${event.code}`));
      expect(await bounded(result.promise)).toEqual(role === "drive" ? { type: "ended", code: "not_pi" } : 403);
    } finally {
      link.stop();
      fixture.close();
    }
  });
}
