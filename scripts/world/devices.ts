/**
 * Browser devices routed into ONE world (R9): each device is its own browser profile. The
 * app's origin is served from a built shell folder, the world's account origin (and the shell's built-in
 * https://account.ovis.sh) goes to the world's account service, the world's relay origin to its relay. Every other
 * request is refused and logged at the same layer, HTTP and WebSocket alike; its pages have no WebRTC and Chrome sends
 * no UDP that does not go through a proxy (no STUN), so nothing reaches a real service. This Chrome runs on the PC: the world's own
 * browser in a container is browser.ts.
 *   const devices = await worldDevices(world.description, { shellDir: "dist-shell" });
 *   const phone = await devices.device("P", PHONE); await capture(phone.page, dir, "p-01"); await devices.close();
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { chromePath } from "../chrome-path.ts";
import { servePagesSite } from "../pages-static.ts";
import { relayBrowserSocket } from "../relay-browser-bridge.ts";
import { NO_WEBRTC_UDP } from "./browser.ts";
import type { WorldDescription } from "./world.ts";

export const PHONE = 390;
export const DESKTOP = 1440;

export interface Device { readonly name: string; readonly context: BrowserContext; readonly page: Page; readonly log: string[]; readonly errors: string[] }
export interface WorldDevices { readonly browser: Browser; readonly app: string; device(name: string, width: number, start?: string): Promise<Device>; close(): Promise<void> }

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const originPattern = (origin: string) => new RegExp(`^${escapeRegExp(origin)}/`);

export async function worldDevices(world: WorldDescription, options: { readonly shellDir: string }): Promise<WorldDevices> {
  const app = world.origins["WORLD_APP_URL"] ?? "https://app.ovis.sh";
  const site = servePagesSite(options.shellDir, 0, "127.0.0.1");
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", NO_WEBRTC_UDP] });
  const accountOrigins = [world.account.url, "https://account.ovis.sh"];

  async function device(name: string, width: number, start: string = app): Promise<Device> {
    const mobile = width < 600;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, locale: "en-US", colorScheme: "dark" });
    const log: string[] = [];
    const errors: string[] = [];
    const stamp = () => new Date().toISOString().slice(11, 23);
    // the last route registered wins: the catch-all refusal first, then the world's own origins
    await context.route(/.*/, async (route) => { log.push(`${stamp()} BLOCKED ${route.request().method()} ${route.request().url()}`); await route.abort(); });
    await context.route(originPattern(app), async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${site.port}${url.pathname}${url.search}` }) });
    });
    for (const origin of accountOrigins) {
      await context.route(originPattern(origin), async (route) => {
        const request = route.request();
        const cors = { "access-control-allow-origin": request.headers()["origin"] ?? "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE", "vary": "origin" };
        if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
        const url = new URL(request.url());
        const body = request.postDataBuffer();
        const answer = await fetch(`${world.account.address}${url.pathname}${url.search}`, { method: request.method(), headers: { ...request.headers(), "x-world-origin": url.origin }, ...(body === null ? {} : { body: new Uint8Array(body) }), redirect: "manual" });
        log.push(`${stamp()} ACCOUNT ${request.method()} ${url.pathname} -> ${answer.status}`);
        const location = answer.headers.get("location");
        if (answer.status === 302 && location !== null) {
          await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
          return;
        }
        const headers = Object.fromEntries([...answer.headers].filter(([key]) => key !== "content-encoding" && key !== "content-length"));
        await route.fulfill({ status: answer.status, headers: { ...headers, ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
      });
    }
    // every WebSocket first refused and logged; the world's relay below wins for its own URL (the last route registered)
    await context.routeWebSocket(/.*/, (ws) => { log.push(`${stamp()} BLOCKED WS ${ws.url()}`); void ws.close({ code: 1008, reason: "not this world" }); });
    await context.routeWebSocket(new RegExp(`^${escapeRegExp(world.relay.url)}/`), (ws) => {
      log.push(`${stamp()} WS ${ws.url()}`);
      relayBrowserSocket(ws, () => { const target = new URL(ws.url()); return `${world.relay.address}${target.pathname}${target.search}`; });
    });
    // and WebRTC is gone from its pages: this PC's Chrome still gathers a host candidate under the UDP flag alone
    await context.addInitScript(() => { for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate"]) Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); });
    await context.addInitScript(() => { if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })); });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(`${stamp()} ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") log.push(`${stamp()} console.${message.type()} ${message.text().slice(0, 300)}`); });
    await page.goto(start);
    return { name, context, page, log, errors };
  }

  return { browser, app, device, close: async () => { await browser.close(); site.stop(true); } };
}

/** A screenshot and the page's visible text, kept as evidence under `dir`. */
export async function capture(page: Page, dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" });
  const text = await page.evaluate(() => document.body.innerText);
  writeFileSync(join(dir, `${name}.txt`), text);
  return text;
}
