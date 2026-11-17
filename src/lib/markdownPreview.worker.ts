import { parseMarkdown, type MarkdownBlock } from "../../shared/markdown.ts";
import { serveOffThread } from "./offThread.ts";
import { PREVIEW_ELEMENT_LIMIT, previewElements } from "./textPreview.ts";

serveOffThread<string, MarkdownBlock[] | null>((text) => {
  const blocks = parseMarkdown(text, 0, true);
  return { result: previewElements(blocks) > PREVIEW_ELEMENT_LIMIT ? null : blocks };
});
