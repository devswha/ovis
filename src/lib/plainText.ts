/**
 * A markdown answer's words as its TXT copy hands them over: code fences keep their code, links
 * keep their words, and emphasis marks, headings and quote marks drop out. The MD copy keeps the
 * answer as written; this is its plain form only.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^>\s?/gm, "");
}
