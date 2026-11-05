import { afterEach, describe, expect, it } from "bun:test";
import { chooseWindow } from "./windowCapture.ts";

describe("chooseWindow", () => {
  const original = globalThis.navigator;
  const originalDocument = globalThis.document;
  afterEach(() => { globalThis.navigator = original; globalThis.document = originalDocument; });

  it("stops an entire-screen selection before creating or uploading a frame", async () => {
    let stopped = false;
    let requested: DisplayMediaStreamOptions | undefined;
    const track = { getSettings: () => ({ displaySurface: "monitor" }), stop: () => { stopped = true; } };
    globalThis.navigator = { mediaDevices: { getDisplayMedia: async (options: DisplayMediaStreamOptions) => {
      requested = options;
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    } } } as unknown as Navigator;
    await expect(chooseWindow()).rejects.toThrow("window_only");
    expect(stopped).toBe(true);
    expect(requested?.video).toEqual({ displaySurface: "window" });
    expect(requested?.audio).toBe(false);
  });

  it("captures only the selected window as bounded JPEG frames until stopped", async () => {
    let stopped = false;
    let drawn = false;
    const track = { readyState: "live", getSettings: () => ({ displaySurface: "window" }), stop: () => { stopped = true; }, addEventListener: () => undefined };
    const video = { videoWidth: 1920, videoHeight: 1080, srcObject: null as unknown, muted: false, playsInline: false, play: async () => undefined };
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => { drawn = true; } }), toBlob: (done: (blob: Blob) => void) => done(new Blob(["jpeg"], { type: "image/jpeg" })) };
    globalThis.navigator = { mediaDevices: { getDisplayMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } } as unknown as Navigator;
    globalThis.document = { createElement: (name: string) => name === "video" ? video : canvas } as unknown as Document;
    const capture = await chooseWindow();
    const frame = await capture.frame();
    expect(frame.type).toBe("image/jpeg");
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(900);
    expect(drawn).toBe(true);
    capture.stop();
    expect(stopped).toBe(true);
    expect(video.srcObject).toBeNull();
  });
});
