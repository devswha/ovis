import type { InlineNode } from "../../shared/markdown.ts";

/** Adapted from t3code's ChatMarkdown. */
const SLOT_MAX_REM = 30;

export function standaloneImage(nodes: InlineNode[]): boolean {
  const shown = nodes.filter((node) => node.type !== "text" || node.value.trim() !== "");
  const node = shown.length === 1 ? shown[0]! : null;
  if (node === null) return false;
  return node.type === "image" || (node.type === "link" && standaloneImage(node.children));
}

export function imageSlotStyle(width?: number): { maxWidth: string } {
  const bounds = ["100%", `${SLOT_MAX_REM}rem`];
  if (width !== undefined && Number.isFinite(width) && width > 0) bounds.push(`${Math.round(width)}px`);
  return { maxWidth: `min(${bounds.join(", ")})` };
}
