export function authTokenFromHash(hash: string): string | null {
  const match = /^#auth=(.+)$/.exec(hash);
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function takeAuthTokenFromUrl(): string | null {
  if (!window.location.hash.startsWith("#auth=")) return null;
  const token = authTokenFromHash(window.location.hash);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return token;
}
