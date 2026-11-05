/**
 * The fonts this PC serves from its state folder's `fonts/` (shared/user-fonts.ts), added to the page
 * for the families a font field in Settings names, so a phone draws a font it does not have as the PC
 * does (#412). While no field names a font nothing is asked, and a family no served file has is left
 * to the fonts installed on the device. Each file comes through the API, so it reaches the page over
 * the relay as well, and is kept in the browser's cache storage where there is one.
 */

import { USER_FONTS_PATH, type UserFont, type UserFontList } from "../../shared/user-fonts.ts";
import { apiFetch } from "./api-request-id.ts";
import { sanitizeFontFamily } from "./fontFamily.ts";

// public/sw.js clears caches of other names when a new build takes over: a font is fetched again once per update
const CACHE = "ovis-user-fonts";
const FILE_TIMEOUT_MS = 120_000;

/** The list, once per set of names: a family typed anew asks again, so a file added since is found. */
const lists = new Map<string, Promise<readonly UserFont[]>>();
const faces = new Map<string, Promise<void>>();

function namesIn(family: string): string[] {
  return [...new Set(sanitizeFontFamily(family).split(",").map((name) => name.trim().replace(/^"(.*)"$/, "$1").toLowerCase()).filter((name) => name !== ""))].sort();
}

async function fetchList(): Promise<readonly UserFont[]> {
  const response = await apiFetch(USER_FONTS_PATH);
  // a server from before this route serves none
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`${USER_FONTS_PATH} answered ${response.status}`);
  return ((await response.json()) as UserFontList).fonts;
}

async function bytesOf(font: UserFont): Promise<ArrayBuffer> {
  const path = `${USER_FONTS_PATH}/${encodeURIComponent(font.file)}`;
  const url = `${path}?v=${encodeURIComponent(font.version)}`;
  const cache = typeof caches === "undefined" ? null : await caches.open(CACHE).catch(() => null);
  const kept = await cache?.match(url);
  if (kept) return kept.arrayBuffer();
  const response = await apiFetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (cache) {
    // the file's older versions go, so a replaced font does not stay on the phone
    for (const old of await cache.keys()) if (new URL(old.url).pathname === path) await cache.delete(old);
    await cache.put(url, new Response(bytes));
  }
  return bytes;
}

function addFace(font: UserFont, fonts: Pick<FontFaceSet, "add">): Promise<void> {
  const key = `${font.file}\n${font.version}`;
  let added = faces.get(key);
  if (added) return added;
  added = bytesOf(font).then(async (bytes) => {
    const face = new FontFace(font.family, bytes, { weight: String(font.weight), style: font.style });
    // in the set while it loads, so what follows the set's faces (lib/fontFaces.ts) sees it arrive
    fonts.add(face);
    await face.loaded;
  }).catch((error: unknown) => {
    // asked again on the next change of a font field
    faces.delete(key);
    console.warn(`The font ${font.file} served by this PC could not be loaded`, error);
  });
  faces.set(key, added);
  return added;
}

/**
 * Resolves once the served files of the families `family` names have loaded or failed; never rejects.
 * A family no field names, a device without FontFace and a server without fonts/ add nothing.
 */
export async function addServedFonts(family: string, fonts: Pick<FontFaceSet, "add"> | undefined = typeof document === "undefined" ? undefined : document.fonts): Promise<void> {
  const names = namesIn(family);
  if (names.length === 0 || !fonts || typeof FontFace === "undefined") return;
  const key = names.join(",");
  let listed = lists.get(key);
  if (!listed) {
    listed = fetchList().catch((error: unknown) => {
      lists.delete(key);
      console.warn("The fonts this PC serves could not be listed", error);
      return [];
    });
    lists.set(key, listed);
  }
  const named = new Set(names);
  const served = (await listed).filter((font) => named.has(font.family.normalize("NFC").toLowerCase()));
  await Promise.all(served.map((font) => addFace(font, fonts)));
}
