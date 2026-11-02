/** One image-only thread: no pane discovery, herdr calls or authentication runs here. */
import { claudeImageFileGeneration, type ClaudeImageRead } from "./claude-image-file.ts";
import type { ClaudeImageRequest, ClaudeImageResult } from "./claude-image-pool.ts";
import { forgetTranscriptImage, transcriptImageAsync } from "./conversation.ts";

declare const self: Worker;

/** The explicit-path reader is safe to import: its stores and RPC clients start only when called. */
export async function readClaudeImage(request: ClaudeImageRequest): Promise<ClaudeImageResult | null> {
  const { job, opened } = request;
  if (job.op !== undefined) {
    const generation = claudeImageFileGeneration(job.path);
    if (generation !== null && (job.op === "inspect" || generation === job.generation)) return { generation };
    if (job.op === "check") forgetTranscriptImage(job.path);
    return null;
  }
  const read: ClaudeImageRead = { expected: job.generation, opened };
  // Keep the bounded boundary/revision caches in this thread: gallery images reuse their history.
  const image = await transcriptImageAsync(job.path, job.ref, read);
  return image !== null && read.observed !== undefined ? { ...image, generation: read.observed } : null;
}

self.onmessage = async (event: MessageEvent<ClaudeImageRequest>) => {
  const request = event.data;
  try {
    const result = await readClaudeImage(request);
    postMessage({ id: request.id, result }, result !== null && "bytes" in result ? [result.bytes.buffer] : []);
  } catch (error) {
    postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
