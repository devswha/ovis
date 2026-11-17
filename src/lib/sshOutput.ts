import { trimUrl } from "../../shared/markdown.ts";

export type SshOutputPart = { type: "text"; value: string } | { type: "link"; href: string; value: string };

export function sshOutputParts(text: string): SshOutputPart[] {
  const parts: SshOutputPart[] = [];
  let offset = 0;
  for (const match of text.matchAll(/(?:^|[\s(<["'])(https:\/\/[^\s<>"']+)/gi)) {
    const index = match.index! + match[0].length - match[1]!.length;
    const url = trimUrl(match[1]!);
    if (url.length <= "https://".length) continue;
    if (index > offset) parts.push({ type: "text", value: text.slice(offset, index) });
    parts.push({ type: "link", href: url, value: url });
    offset = index + url.length;
  }
  if (offset < text.length) parts.push({ type: "text", value: text.slice(offset) });
  return parts;
}
