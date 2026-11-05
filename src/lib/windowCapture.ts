/** Browser permission and frames for one user-selected window or tab. */
export interface WindowCapture {
  frame(): Promise<Blob>;
  stop(): void;
  onEnded(callback: () => void): void;
}

export async function chooseWindow(): Promise<WindowCapture> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("window_capture_unavailable");
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: { displaySurface: "window" },
    monitorTypeSurfaces: "exclude",
    selfBrowserSurface: "exclude",
  } as DisplayMediaStreamOptions);
  const track = stream.getVideoTracks()[0];
  const surface = track?.getSettings().displaySurface;
  // Hints do not constrain the browser's picker. Verify its actual choice before uploading.
  if (!track || (surface !== "window" && surface !== "browser")) {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error("window_only");
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try { await video.play(); }
  catch (error) { track.stop(); throw error; }
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    track.stop();
    throw new Error("window_capture_unavailable");
  }
  let stopped = false;
  return {
    async frame(): Promise<Blob> {
      if (stopped || track.readyState !== "live") throw new Error("window_capture_ended");
      const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("window_capture_unavailable");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!image || stopped) throw new Error("window_capture_ended");
      return image;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((item) => item.stop());
      video.srcObject = null;
    },
    onEnded(callback) { track.addEventListener("ended", callback, { once: true }); },
  };
}
