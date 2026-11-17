/**
 * Network shares on a Windows PC. Reading a path on one (a stat is enough) makes Windows ask that host for the
 * file and sign in to it with the user's account, so a path that a link, an address or an agent's reply names
 * must not reach the filesystem as one.
 */

/** The names Windows serves WSL's own files under: this PC, and no other host. */
const WSL_HOSTS = new Set(["wsl$", "wsl.localhost"]);

/**
 * The host and share of a path Windows has resolved (`\\host\share\…`), in lower case, in its long form too
 * (`\\?\UNC\host\share\…`, as a pane's folder may be told). undefined for a path on a drive, in its long form
 * too (`\\?\C:\…`); null for any other device path (`\\.\…`, `\\?\GLOBALROOT\…`), which can name a share in
 * more ways than are worth telling apart.
 */
function shareOf(path: string): string | null | undefined {
  if (!path.startsWith("\\\\") || /^\\\\\?\\[a-z]:(?:\\|$)/i.test(path)) return undefined;
  const [, host = "", share = ""] = /^\\\\(?:\?\\UNC\\)?([^\\]*)\\?([^\\]*)/i.exec(path) ?? [];
  return host === "?" || host === "." ? null : `${host}\\${share}`.toLowerCase();
}

let paneShares: ReadonlySet<string> = new Set();

export function notePaneFolders(folders: Iterable<string | null | undefined>): void {
  const shares = new Set<string>();
  for (const folder of folders) {
    const share = folder ? shareOf(folder.replaceAll("/", "\\")) : undefined;
    if (share) shares.add(share);
  }
  paneShares = shares;
}

export function otherHostsShare(path: string, own: ReadonlyArray<string | null>): boolean {
  const share = shareOf(path);
  if (share === undefined) return false;
  if (share === null) return true;
  if (WSL_HOSTS.has(share.slice(0, share.indexOf("\\")))) return false;
  return !paneShares.has(share) && !own.some((folder) => folder !== null && shareOf(folder) === share);
}
