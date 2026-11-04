import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { markdownImagePreview, type MarkdownImagePreview } from "../lib/markdownImages.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { MarkdownImageContext, MarkdownImageOpenContext, MarkdownImageRetryContext, type MarkdownImageResolver } from "./Markdown.tsx";

/** Images a chat resolved, per PC, pane and source: a reopened chat draws them before it stats them again. */
const resolved = new Map<string, MarkdownImagePreview>();
const REMEMBERED_PREVIEWS = 500;

/** Resolve on the pane's PC; the viewer stays with ChatView when an image's row scrolls away. */
export function ChatMarkdownImages({ paneId, cwd, connected, onOpen, children }: {
  paneId: string; cwd: string | null; connected: boolean; onOpen: (image: GalleryImage) => void; children: ReactNode;
}) {
  const machineId = useMachineId();
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const previous = useRef({ connected, cwd, paneId, fetchFileInfo });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const before = previous.current;
    previous.current = { connected, cwd, paneId, fetchFileInfo };
    const sameOwner = before.paneId === paneId && before.fetchFileInfo === fetchFileInfo;
    if (sameOwner && ((connected && !before.connected) || cwd !== before.cwd)) setRefresh((epoch) => epoch + 1);
  }, [connected, cwd, paneId, fetchFileInfo]);
  const resolve = useMemo(() => {
    const key = (src: string) => `${machineId}\0${paneId}\0${src}`;
    const resolver: MarkdownImageResolver = async (src) => {
      // The server prefers foreground_cwd over pane.cwd and returns the canonical byte path.
      const preview = await markdownImagePreview(src, null,
        (path) => fetchFileInfo(path, paneId), (path, download) => fileUrl(path, paneId, download));
      resolved.delete(key(src));
      if (preview?.kind === "inline") {
        resolved.set(key(src), preview);
        if (resolved.size > REMEMBERED_PREVIEWS) resolved.delete(resolved.keys().next().value!);
      }
      return preview;
    };
    resolver.peek = (src) => resolved.get(key(src));
    return resolver;
  }, [machineId, paneId, fetchFileInfo, fileUrl]);
  return <MarkdownImageContext.Provider value={resolve}>
    <MarkdownImageRetryContext.Provider value={refresh}>
      <MarkdownImageOpenContext.Provider value={onOpen}>{children}</MarkdownImageOpenContext.Provider>
    </MarkdownImageRetryContext.Provider>
  </MarkdownImageContext.Provider>;
}
