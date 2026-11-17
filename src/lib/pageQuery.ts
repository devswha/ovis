import { shellMode, type ShellMode } from "./shellMode.ts";

export function pageSearch(location: { search: string; hash: string } = window.location, mode: ShellMode = shellMode()): string {
  if (mode !== "relay") return location.search;
  if (location.search.length > 1) return location.search;
  return location.hash.length > 1 && !location.hash.startsWith("#offer=") ? `?${location.hash.slice(1)}` : "";
}

interface LinkClick { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; currentTarget: { getAttribute(name: string): string | null }; preventDefault(): void }
interface Reloadable { location: { pathname: string; reload(): void }; history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void } }

/**
 * A plain click on a link to this page's own address (`pageAddress`), such as Reconnect: in the
 * hosted shell it changes only the fragment, which loads nothing, so the page takes the address
 * and reloads. A click that opens a new tab or window, or saves the link, is the browser's.
 */
export function reloadOnPlainClick(event: LinkClick, page: Reloadable = window, mode: ShellMode = shellMode()): void {
  if (mode !== "relay" || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  page.history.replaceState(page.history.state, "", event.currentTarget.getAttribute("href") ?? page.location.pathname);
  page.location.reload();
}

export function moveQueryToFragment(page: { location: { pathname: string; search: string }; history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void } }): boolean {
  if (page.location.search.length <= 1) return false;
  page.history.replaceState(page.history.state, "", `${page.location.pathname}#${page.location.search.slice(1)}`);
  return true;
}

export function pageAddress(pathname: string, search: string, hash: string, mode: ShellMode = shellMode()): string {
  if (mode !== "relay") return `${pathname}${search}${hash}`;
  const query = search.startsWith("?") ? search.slice(1) : search;
  return query === "" ? pathname : `${pathname}#${query}`;
}
