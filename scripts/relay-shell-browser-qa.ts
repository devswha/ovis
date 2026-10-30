/**
 * The hosted shell in a real browser, served from dist-shell/ as Cloudflare Pages would serve it
 * (pages-static.ts), under its enforced policy. Run after `bun run build:shell`. No relay and no
 * PC take part: the screens before a connection are what this proves, with the relay address
 * pointed at a closed loopback port so a connection fails at once instead of waiting.
 *
 *   UI_EVIDENCE_DIR=<dir> bun scripts/relay-shell-browser-qa.ts
 *
 * writes the screenshots and logs there (task-16-*); without it the checks still run.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { encodeOffer } from "../shared/relay-offer.ts";
import { shellContentSecurityPolicy } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import { assertCspClean, watchCsp } from "./csp-violations.ts";
import type { CspWatch } from "./csp-violations.ts";
import { servePagesSite } from "./pages-static.ts";

const repo = join(import.meta.dir, "..");
const evidence = process.env["UI_EVIDENCE_DIR"] ?? null;
if (evidence) mkdirSync(evidence, { recursive: true });
const keep = (name: string, text: string): void => { if (evidence) writeFileSync(join(evidence, name), text); };

const ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
/** a closed loopback port: a wss: origin isWssOrigin accepts, which refuses the connection at once */
const RELAY = "wss://127.0.0.1:1";
const SERVER_KEY = exportPublicKey(generateKeyPair().publicKey);

const server = servePagesSite(join(repo, "dist-shell"), 0);
const origin = `http://127.0.0.1:${server.port}`;
const offerUrl = encodeOffer({ v: 1, server_id: ID, server_public_key: SERVER_KEY, relay: RELAY, code: "123456", name: "Desk PC" }, origin);

let browser: Browser | undefined;
const csp: CspWatch[] = [];
const report: string[] = [];

interface Seeded { server_id: string; server_public_key: string; name: string }
/** Saved PCs, written as lib/relay/device.ts writes them, with a real non-extractable key. */
const seed = async (page: Page, devices: Seeded[]): Promise<void> => {
  await page.evaluate(async (devices) => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ovis-relay", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("devices", { keyPath: "server_id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("devices", "readwrite");
      for (const device of devices) {
        tx.objectStore("devices").put({ ...device, relay: "wss://127.0.0.1:1", device_id: "device-1", private_key: keys.privateKey, public_spki: "spki", label: "QA phone" });
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, devices);
};

/** The app's theme setting is dark unless set (lib/settings.ts), so a light capture names it. */
const open = async (context: BrowserContext, theme: "dark" | "light" = "dark"): Promise<Page> => {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.addInitScript((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })), theme);
  csp.push(await watchCsp(page));
  return page;
};

const state = (page: Page, name: string) => page.locator(`main[data-relay-state="${name}"]`);

try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

  // (a) nothing saved, no offer: the front page asks for the PC's QR code, in both themes at both widths
  for (const [device, width, height] of [["mobile", 390, 844], ["desktop", 1440, 900]] as const) {
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2, isMobile: device === "mobile", hasTouch: device === "mobile" });
      const page = await open(context, scheme);
      const response = await page.goto(`${origin}/`);
      assert.equal(response?.headers()["content-security-policy"], shellContentSecurityPolicy(), "the front page carries the shell policy");
      assert.equal(await page.evaluate(() => document.documentElement.dataset["theme"]), scheme, `the ${scheme} theme is on the document`);
      await state(page, "empty").waitFor();
      await page.getByRole("heading", { name: "Scan the QR code on your PC" }).waitFor();
      assert.equal(await page.locator("main button").count(), 0, "the front page offers no Back");
      if (evidence) await page.screenshot({ path: join(evidence, `task-16-empty-${device}-${scheme}.png`) });
      await context.close();
    }
  }
  report.push("empty: front page without a saved PC shows the QR instruction at 390 and 1440, light and dark");

  // (b) a damaged offer: the damaged screen, and not one request beyond this origin, not one socket
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await open(context);
    const requests: string[] = [];
    const sockets: string[] = [];
    page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
    page.on("websocket", (socket) => sockets.push(socket.url()));
    const before = `${origin}/s/${ID}/#offer=abc`;
    await page.goto(before);
    await state(page, "bad-offer").waitFor();
    await page.getByRole("heading", { name: "This pairing link is damaged" }).waitFor();
    const after = await page.evaluate(() => location.href);
    assert.equal(after, `${origin}/s/${ID}/`, "the fragment left the address bar");
    assert.ok(!after.includes("#offer"), "no offer in the address");
    const foreign = requests.filter((line) => !line.includes(` ${origin}/`));
    assert.deepEqual(foreign, [], "every request stayed on the shell's origin");
    assert.deepEqual(sockets, [], "no socket was opened for a damaged offer");
    assert.ok(!requests.some((line) => line.includes("/v1/ws")), "no relay request");
    if (evidence) await page.screenshot({ path: join(evidence, "task-16-bad-offer.png") });
    keep("task-16-bad-offer-requests.txt", `# every request the page made while showing the damaged-offer screen (${requests.length}); websockets: ${sockets.length}\n# origin: ${origin}\n${requests.join("\n")}\n`);
    keep("task-16-fragment.txt", `# the address before boot and after it\nbefore: ${before}\nafter:  ${after}\n`);
    // the page's history holds no offer either: going back from here would not replay it
    const entries = await page.evaluate(() => history.length);
    report.push(`bad-offer: damaged screen shown; ${requests.length} requests, all on ${origin}; 0 sockets; address after boot ${after}; history entries ${entries}`);
    await context.close();
  }

  // (c) a saved PC whose key is not the offer's: the identity screen, with no socket; forgetting it pairs again, and a dead relay is unreachable
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light", deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await open(context, "light");
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto(`${origin}/s/${ID}/`);
    await state(page, "empty").waitFor();
    await seed(page, [{ server_id: ID, server_public_key: "not-the-offer's-key", name: "Desk PC" }]);
    // a link pasted into the open tab changes only the fragment: the shell hears it and asks
    await page.evaluate((url) => { location.href = url; }, offerUrl);
    await state(page, "confirm").waitFor();
    await page.getByRole("button", { name: "Not now" }).waitFor();
    // the same link opened fresh, as a scanned code opens it
    await page.goto("about:blank");
    await page.goto(offerUrl);
    await state(page, "confirm").waitFor();
    await page.getByRole("heading", { name: "Pair with Desk PC?" }).waitFor();
    assert.ok(!(await page.evaluate(() => location.href)).includes("#offer"), "the offer left the address before the question");
    if (evidence) await page.screenshot({ path: join(evidence, "task-16-confirm.png") });
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await state(page, "identity-changed").waitFor();
    await page.getByRole("heading", { name: "Desk PC has a new identity" }).waitFor();
    assert.deepEqual(sockets, [], "a changed identity is refused before any socket opens");
    if (evidence) await page.screenshot({ path: join(evidence, "task-16-identity-changed.png") });
    await page.getByRole("button", { name: "Forget this PC" }).click();
    await state(page, "relay-unreachable").waitFor();
    await page.getByRole("heading", { name: "The relay could not be reached" }).waitFor();
    assert.equal(sockets.length, 1, "forgetting the PC pairs again, which opens one socket to the offer's relay");
    assert.ok(sockets[0]!.startsWith(`${RELAY}/v1/ws?server_id=${ID}&role=client&v=1`), sockets[0]);
    if (evidence) await page.screenshot({ path: join(evidence, "task-16-relay-unreachable.png") });
    await page.getByRole("button", { name: "Try again" }).click();
    await state(page, "relay-unreachable").waitFor();
    assert.equal(sockets.length, 2, "Try again opens one more socket");
    report.push(`identity-changed: stale key refused before any socket (${sockets.length} sockets after two deliberate attempts: ${sockets.join(", ")})`);
    await context.close();
  }

  // (d) two saved PCs: the front page lists them, a row opens the PC's own scope, where it connects on its own
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    const page = await open(context);
    await page.goto(`${origin}/`);
    await state(page, "empty").waitFor();
    await seed(page, [{ server_id: ID, server_public_key: SERVER_KEY, name: "Desk PC" }, { server_id: OTHER_ID, server_public_key: SERVER_KEY, name: "Laptop" }]);
    await page.reload();
    await state(page, "list").waitFor();
    const rows = page.locator(".relay-shell-pc");
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.nth(1).getAttribute("href"), `/s/${OTHER_ID}/`);
    if (evidence) await page.screenshot({ path: join(evidence, "task-16-list.png") });
    await rows.nth(1).click();
    await page.waitForURL(`${origin}/s/${OTHER_ID}/`);
    await state(page, "relay-unreachable").waitFor();
    await page.getByRole("heading", { name: "The relay could not be reached" }).waitFor();
    await page.getByRole("button", { name: "Back" }).click();
    await page.waitForURL(`${origin}/`);
    await state(page, "list").waitFor();
    report.push("list: two saved PCs listed; a row opens /s/<id>/ which connects by itself; Back returns to the list");
    await context.close();
  }

  // (e) a PC's scope: its own worker, its own manifest, the shell policy and the worker rewrite
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await open(context);
    const response = await page.goto(`${origin}/s/${ID}/`);
    assert.equal(response?.headers()["content-security-policy"], shellContentSecurityPolicy());
    await state(page, "empty").waitFor();
    const facts = await page.evaluate(async (id) => {
      const registration = await navigator.serviceWorker.ready;
      const manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement;
      const manifest = await (await fetch(manifestLink.href)).json() as Record<string, string>;
      const worker = await fetch(`/s/${id}/sw.js`);
      return {
        scope: new URL(registration.scope).pathname,
        script: new URL(registration.active?.scriptURL ?? registration.installing?.scriptURL ?? "").pathname,
        manifestHref: new URL(manifestLink.href).pathname,
        manifest: { id: manifest["id"], start_url: manifest["start_url"], scope: manifest["scope"] },
        workerType: worker.headers.get("content-type"),
        meta: document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") ?? null,
      };
    }, ID);
    assert.deepEqual(facts, {
      scope: `/s/${ID}/`, script: `/s/${ID}/sw.js`, manifestHref: `/s/${ID}/manifest.webmanifest`,
      manifest: { id: "./", start_url: "./", scope: "./" }, workerType: "text/javascript; charset=utf-8", meta: "relay",
    });
    keep("task-16-scope.txt", `# a PC's page in the hosted shell: what the browser registered and read\n${JSON.stringify(facts, null, 2)}\n`);
    report.push(`scope: worker ${facts.script} at scope ${facts.scope}; manifest ${facts.manifestHref} with id/start_url/scope ./`);
    await context.close();
  }

  assertCspClean(csp, "the hosted shell's screens under the enforced shell policy");
  report.push(`csp: ${csp.length} watched pages, every one served the policy, no violation`);
  keep("task-16-browser-qa.txt", `# relay-shell-browser-qa against ${origin} (dist-shell via scripts/pages-static.ts)\n${report.join("\n")}\n`);
  console.log(report.join("\n"));
} finally {
  await browser?.close();
  server.stop(true);
}
