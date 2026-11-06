import { useEffect, useState } from "react";

import { MAX_INLINE_IMAGE_BYTES } from "./markdownImages.ts";
import { getTransport } from "./transport.ts";

/** Keep only the open viewer's selected original file ready before the share gesture. */
export function useImageShare(src: string | undefined, name: string | undefined, enabled: boolean): File | null | undefined {
  const available = enabled && typeof navigator.share === "function" && typeof navigator.canShare === "function";
  const [ready, setReady] = useState<{ src: string; name: string; file: File | null } | null>(null);
  useEffect(() => {
    if (!available || src === undefined || name === undefined) return;
    setReady(null);
    const abort = new AbortController();
    void imageFile(src, name, abort.signal).then(
      (file) => { if (!abort.signal.aborted) setReady({ src, name, file }); },
      () => { if (!abort.signal.aborted) setReady({ src, name, file: null }); },
    );
    return () => { abort.abort(); };
  }, [src, name, available]);
  if (!available) return null;
  return ready !== null && ready.src === src && ready.name === name ? ready.file : undefined;
}

/** Bound chunked as well as length-declared responses; never re-encode the picture. */
async function imageFile(src: string, name: string, signal: AbortSignal): Promise<File> {
  // Only server paths belong to the authenticated transport; data/blob URLs are local bytes.
  const response = await (src.startsWith("/api/") ? getTransport().fetch(src, { signal }) : fetch(src, { signal }));
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_INLINE_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Image unavailable or too large to share");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Image body unavailable");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INLINE_IMAGE_BYTES) throw new Error("Image too large to share");
      chunks.push(value);
    }
    signal.throwIfAborted();
    return new File(chunks, name, { type: response.headers.get("content-type")?.split(";", 1)[0] ?? "" });
  } finally {
    try { await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}
