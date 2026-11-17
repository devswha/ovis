/** Same-origin and external, never inline: the app's policy allows `script-src 'self'` only. */
import "./lib/legacyStorage.ts";
import { applyThemeEntry, savedThemeEntry } from "./lib/themeBoot.ts";
import { regionalAppReady, regionalAppUrl } from "../shared/relay-regions.ts";

const regional = regionalAppUrl(window.location, "Capacitor" in window);
if (regional !== null) {
  const offer = window.location.hash;
  void regionalAppReady(new URL(regional).origin).then((ready) => {
    if (ready && window.location.hash === offer) window.location.replace(regional);
  });
}

const root = document.documentElement;
const entry = savedThemeEntry(() => window.localStorage);
applyThemeEntry(root, entry);
root.style.backgroundColor = entry.bg;
