import type { MarkdownBlock } from "../../shared/markdown.ts";
import { createOffThreadQueue, type OffThreadJob, type WorkerLike } from "./offThread.ts";

export const PREVIEW_BUDGET_MS = 2_000;

const queue = createOffThreadQueue<string, MarkdownBlock[]>(
  () => new Worker(new URL("./markdownPreview.worker.ts", import.meta.url), { type: "module" }) as WorkerLike,
  PREVIEW_BUDGET_MS,
);

let last: { text: string; blocks: MarkdownBlock[] | null } | null = null;

export function knownPreview(text: string): MarkdownBlock[] | null | undefined {
  return last !== null && last.text === text ? last.blocks : undefined;
}

export function parsePreviewOffThread(text: string): OffThreadJob<MarkdownBlock[]> {
  const job = queue(text);
  let dropped = false;
  return {
    cancel: () => {
      if (job.cancel()) dropped = true;
      return dropped;
    },
    promise: job.promise.then((blocks) => {
      if (!dropped) last = { text, blocks };
      return blocks;
    }),
  };
}
