/**
 * The browser of a world (browser.ts), run in a container of its own on the world's sealed network: Playwright's
 * Chromium from the image (PLAYWRIGHT_BROWSERS_PATH), served by the checkout's own playwright-core (WORLD_REPO) as a
 * browser server the PC drives over the world's network. The path of its endpoint is a secret (WORLD_BROWSER_SECRET,
 * from an env file) so a machine of the world, which reaches this address too, cannot drive it.
 * Chromium's flags (WORLD_BROWSER_ARGS, JSON) come from the PC: the world's names to its proxy and every other name to
 * nothing, the proxy's certificate by its key, and no UDP that does not go through a proxy (so no WebRTC).
 */
const REPO = process.env["WORLD_REPO"] ?? "/opt/ovis";
const secret = process.env["WORLD_BROWSER_SECRET"] ?? "";
if (!/^[0-9a-f]{32,}$/.test(secret)) throw new Error("WORLD_BROWSER_SECRET (hex) is required");
const args = JSON.parse(process.env["WORLD_BROWSER_ARGS"] ?? "[]") as string[];
const { chromium }: typeof import("playwright-core") = await import(Bun.resolveSync("playwright-core", REPO));
const server = await chromium.launchServer({ host: "0.0.0.0", port: 9323, wsPath: `/${secret}`, headless: true, args });
console.log(JSON.stringify({ event: "ready", port: 9323 }));
const stop = () => { void server.close().then(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

export {};
