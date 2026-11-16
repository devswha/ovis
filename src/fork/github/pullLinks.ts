/**
 * A chat's link to a pull request (Markdown.tsx) opens its page in Ovis: the Pull requests view says how
 * (GithubInbox.tsx ForkGithubPane) while it is mounted on a device that may read pages. Until then, and for any
 * other link or a modified click, the browser keeps the link.
 */
type Opener = (repository: string, number: number, url: string) => void;
let opener: Opener | null = null;

export function setPullLinkOpener(next: Opener | null): void { opener = next; }

const PULL_LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i;

/** The pull request a link names, or null. */
export function pullLink(href: string): { repository: string; number: number } | null {
  const match = PULL_LINK.exec(href);
  return match === null ? null : { repository: match[1]!, number: Number(match[2]) };
}

export function openPullLink(event: { button: number; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; preventDefault(): void }, href: string, enabled: boolean): boolean {
  const named = pullLink(href);
  if (!enabled || named === null || opener === null || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  event.preventDefault();
  opener(named.repository, named.number, href);
  return true;
}
