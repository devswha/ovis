import { useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * The tail of a folded text (a tool output, a code block). Where the browser can find hidden text
 * (hidden=until-found), the tail stays in the page, drawn as nothing: its find reaches it and unfolds the text.
 * Elsewhere `findable` is false and only the head is drawn (rendered without a page, as to static markup,
 * nothing is found).
 */
export function useFindableTail<T extends HTMLElement>(folded: boolean, setExpanded: (expanded: boolean) => void): { ref: RefObject<T | null>; findable: boolean } {
  const findable = folded && typeof HTMLElement !== "undefined" && "onbeforematch" in HTMLElement.prototype;
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    // React writes `hidden` only as true or false
    node.setAttribute("hidden", "until-found");
    // unfolded before the browser scrolls to the match, so it lands where the unfolded text puts it
    const found = () => flushSync(() => setExpanded(true));
    node.addEventListener("beforematch", found);
    return () => node.removeEventListener("beforematch", found);
  }, [folded, setExpanded]);
  return { ref, findable };
}

/**
 * After a fold: a block whose top is now above the chat is scrolled back to its top, except at the chat's end,
 * where the list keeps a following reader at the end.
 */
export function showFoldedBlock(node: HTMLElement | null): void {
  const view = node?.closest(".chat-view");
  if (!node || !view) return;
  const atEnd = view instanceof HTMLElement && view.scrollHeight - view.clientHeight - view.scrollTop <= 1;
  if (!atEnd && node.getBoundingClientRect().top < view.getBoundingClientRect().top) node.scrollIntoView({ block: "start" });
}
