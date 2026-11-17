/**
 * OSC 52 payload: `<selection>;<base64>`. The selection char (c/p/s) names a clipboard the
 * browser does not have; an empty or `?` payload is a clipboard query.
 */

export const MAX_OSC52_BYTES = 100 * 1024;

export function parseOsc52(payload: string): string | null {
  const separator = payload.indexOf(";");
  if (separator < 0) return null;
  const encoded = payload.slice(separator + 1);
  if (encoded === "" || encoded === "?") return null;
  if (encoded.length > ((MAX_OSC52_BYTES / 3) | 0) * 4 + 4) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.byteLength > MAX_OSC52_BYTES) return null;
  return new TextDecoder().decode(bytes);
}
