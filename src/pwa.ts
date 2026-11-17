// navigator.serviceWorker only exists in secure
// contexts (https:// or localhost), so on a plain http:// LAN/tailnet IP this
// silently does nothing and the app still works uncached.
import { shellMode, shellServiceWorker } from "./lib/shellMode.ts";

window.addEventListener("load", () => {
  if (!("serviceWorker" in navigator)) return;
  const worker = shellMode() === "relay" ? shellServiceWorker(window.location.pathname) : { script: "/sw.js", scope: "/" };
  if (worker === null) return;
  navigator.serviceWorker.register(worker.script, { scope: worker.scope }).catch((err) => {
    console.warn("service worker registration failed", err);
  });
});
