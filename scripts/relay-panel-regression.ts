/**
 * Settings → Phone & devices → Remote access through Ovis relay, against a local Bun relay
 * (relay/bun.ts): the switch turns the relay on and the row says Online, the QR code of a fresh
 * offer comes with its countdown, New code starts another code, a code the Devices group starts
 * refreshes the offer, and the offer's code and the Devices group's code are one and the same
 * both ways (the server keeps one pending code and the offer reuses it), the identity reset
 * gives the PC a new server id, the switch turns the relay off and the row says Off; a
 * serve-only install disables the switch with the reason; the hosted shell shows no group; a
 * device paired through the relay wears the via relay pill. Imported by ui-regression.ts;
 * `startRelayFixture` also serves the manual QA script.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { UsageService } from "../server/usage.ts";
import type { PairedDevice, PairingCode, RelayStatus } from "../shared/protocol.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { openSettingsPage } from "./settings-page.ts";

export interface RelayFixture {
  readonly origin: string;
  readonly relayPort: number;
  stop(): Promise<void>;
}

/** An Ovis server whose relay link reaches a local Bun relay: the advertised wss origin is dialled as the relay's plain ws port. */
export function startRelayFixture(options: { serveOnly?: boolean } = {}): RelayFixture {
  const relay = startBunRelay({ port: 0 });
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-panel-"));
  const service = new RelayService({
    stateDir,
    relay: `wss://127.0.0.1:${relay.port}`,
    connect: (url) => {
      const target = new URL(url);
      return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    },
  });
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false,
    tailscaleServeOnly: options.serveOnly ?? false, relay: service, usage: new UsageService(undefined, []), registerBridge: false,
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    relayPort: relay.port,
    async stop() {
      await service.shutdown();
      server.stop();
      await relay.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

const englishContext = async (browser: Browser, viewport = { width: 1280, height: 800 }): Promise<BrowserContext> => {
  const context = await browser.newContext({ viewport, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  return context;
};

/** The page open on Settings → Phone & devices. */
export async function openPhoneSettings(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Phone & devices");
}

export async function checkRelayPanel(browser: Browser): Promise<void> {
  const fixtures: RelayFixture[] = [];
  const contexts: BrowserContext[] = [];
  const pageErrors: string[] = [];
  try {
    const fixture = startRelayFixture();
    fixtures.push(fixture);
    const relayState = async (): Promise<RelayStatus> => (await fetch(`${fixture.origin}/api/relay`)).json() as Promise<RelayStatus>;
    const context = await englishContext(browser);
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(page, fixture.origin);
    const dialog = page.locator(".settings-dialog");
    const group = dialog.locator('[data-section="relay"]');
    await group.getByRole("heading", { name: "Remote access through Ovis relay", exact: true }).waitFor();
    assert.ok(await group.evaluate((section) => section.previousElementSibling?.getAttribute("data-section") === "phone" && section.nextElementSibling?.getAttribute("data-section") === "devices"),
      "the relay group sits under Phone, where Portal would follow it");
    const toggle = group.getByRole("switch", { name: "Ovis relay", exact: true });
    const state = group.locator(".relay-status");
    const qr = group.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true });
    const offerAnswer = () => page.waitForResponse((response) => response.url().endsWith("/api/relay/offer") && response.request().method() === "POST");
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the relay starts off");
    assert.equal(await toggle.isEnabled(), true, "nothing blocks the relay on a plain install");
    await state.filter({ hasText: "Off." }).waitFor();
    assert.equal(await qr.count(), 0, "no offer while the relay is off");
    assert.equal((await relayState()).phase, "off");
    const closesGate = group.getByText("Turning it on closes the device gate: a new browser then needs a pairing code or the access token.", { exact: true });
    assert.equal(await closesGate.isVisible(), true, "with no token and nothing paired, the row says turning the relay on closes the gate");

    // on: the server connects to the local relay, the row says so, and the offer comes by itself
    const firstOffer = offerAnswer();
    await toggle.click();
    await state.filter({ hasText: "Online. No phone connected." }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "the switch shows the relay on");
    assert.equal((await relayState()).phase, "online", "the server's relay link is online");
    await closesGate.waitFor({ state: "detached" });
    await qr.waitFor();
    const offered = decodeOffer(((await (await firstOffer).json()) as { url: string }).url);
    assert.ok(offered !== null, "the QR code is a pairing offer");
    assert.equal(offered.relay, `wss://127.0.0.1:${fixture.relayPort}`, "the offer names the relay the server uses");
    assert.match(offered.code ?? "", /^\d{6}$/, "the offer carries a one-time pairing code");
    await group.getByText(/Expires in \d+:\d\d\./).waitFor();

    // New code: a new pairing code first (one POST pair/start), then an offer carrying that very code. Codes
    // are six random digits, so two of them are never asserted different: the offer is matched to the code
    // the server just answered, which is deterministic.
    const pairStart = () => page.waitForResponse((response) => response.url().endsWith("/api/devices/pair/start") && response.request().method() === "POST");
    const offerCode = async (answer: Promise<Response>) => {
      const offer = decodeOffer(((await (await answer).json()) as { url: string }).url);
      assert.ok(offer !== null && offer.code !== undefined, "the offer carries a pairing code");
      return offer.code;
    };
    const startedCode = async (answer: Promise<Response>) => {
      const response = await answer;
      assert.equal(response.status(), 200, "the pairing code was started");
      return ((await response.json()) as PairingCode).code;
    };
    const renewedCode = pairStart();
    const secondOffer = offerAnswer();
    await group.getByRole("button", { name: "New code", exact: true }).click();
    assert.equal(await offerCode(secondOffer), await startedCode(renewedCode), "New code's offer carries the code it started");

    // the Devices group starts a code of its own: the server keeps one pending code and the offer reuses it, so
    // the offer is asked for again and carries the very code the Devices group shows
    const devicesGroup = dialog.locator('[data-section="devices"]');
    const devicesCode = async () => (await devicesGroup.locator(".devices-code").innerText()).replace(/\s+/g, "");
    const devicesStart = pairStart();
    const resynced = offerAnswer();
    await devicesGroup.getByRole("button", { name: "Pair a device", exact: true }).click();
    await devicesGroup.locator(".devices-code").waitFor();
    const devicesStarted = await startedCode(devicesStart);
    assert.equal(await offerCode(resynced), devicesStarted, "a code the Devices group started refreshes the relay offer with that code");
    assert.equal(await devicesCode(), devicesStarted, "the relay QR carries the code the Devices group shows");
    await qr.waitFor();

    // New code while both are shown: the Devices group follows the code the relay panel started, so they stay equal
    const followedStart = pairStart();
    const followedOffer = offerAnswer();
    await group.getByRole("button", { name: "New code", exact: true }).click();
    const followed = await startedCode(followedStart);
    assert.equal(await offerCode(followedOffer), followed, "the relay QR carries the code New code started");
    await page.waitForFunction(([selector, code]) => document.querySelector(selector)?.textContent?.replace(/\s+/g, "") === code, ['[data-section="devices"] .devices-code', followed] as const);
    assert.equal(await devicesCode(), followed, "after New code the Devices group shows the same code as the relay QR");
    await qr.waitFor();

    // the identity reset asks first; Cancel changes nothing, Reset gives the PC a new server id and a fresh offer
    const reset = group.getByRole("button", { name: "Reset", exact: true });
    const confirm = page.getByRole("alertdialog", { name: "Reset the relay identity?", exact: true });
    await reset.click();
    await confirm.getByText("Phones paired through the relay will need to scan a new code.", { exact: true }).waitFor();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await qr.waitFor();
    const afterReset = offerAnswer();
    await reset.click();
    await confirm.getByRole("button", { name: "Reset", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    const rotated = decodeOffer(((await (await afterReset).json()) as { url: string }).url);
    assert.ok(rotated !== null && rotated.server_id !== offered.server_id, "the reset gives the PC a new relay identity");
    assert.notEqual(rotated.server_public_key, offered.server_public_key);
    await state.filter({ hasText: "Online. No phone connected." }).waitFor();
    await qr.waitFor();

    // off: the row says so and the offer goes with the connection
    await toggle.click();
    await state.filter({ hasText: "Off." }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the switch shows the relay off");
    await qr.waitFor({ state: "detached" });
    assert.equal(await group.getByRole("button", { name: "New code", exact: true }).count(), 0, "no offer while the relay is off");
    assert.equal((await relayState()).phase, "off", "the server's relay link is off");

    // the hosted shell: the same page with the shell's meta tag has no relay group. The tag goes in from an init
    // script, not a rewritten document: a document Playwright fulfils leaves the local address space, and Chrome's
    // local-network-access check then blocks the page's own WebSocket to 127.0.0.1.
    const shell = await englishContext(browser);
    contexts.push(shell);
    await shell.addInitScript(() => {
      const add = () => {
        const meta = document.createElement("meta");
        meta.name = "ovis-shell";
        meta.content = "relay";
        document.head.appendChild(meta);
      };
      if (document.head) add();
      else new MutationObserver((_, observer) => { if (document.head) { observer.disconnect(); add(); } }).observe(document, { childList: true, subtree: true });
    });
    const shellPage = await shell.newPage();
    shellPage.setDefaultTimeout(15_000);
    shellPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(shellPage, fixture.origin);
    await shellPage.locator('.settings-dialog [data-section="devices"]').waitFor();
    assert.equal(await shellPage.locator('.settings-dialog [data-section="relay"]').count(), 0, "the hosted shell shows no relay group");

    // a device paired through the relay wears the pill
    const paired: PairedDevice = { id: "0123456789abcdef", label: "Pixel 9", role: "drive", created_at: new Date().toISOString(), last_seen_at: null, current: false, via_relay: true };
    await shellPage.route("**/api/devices", (route) => route.request().method() === "GET" ? route.fulfill({ json: { devices: [paired] } }) : route.continue());
    await openPhoneSettings(shellPage, fixture.origin);
    const row = shellPage.locator(".devices-row").filter({ hasText: "Pixel 9" });
    await row.locator(".devices-via-relay", { hasText: "via relay" }).waitFor();

    // serve-only: the switch is there and disabled, with the reason in the row
    const serveOnly = startRelayFixture({ serveOnly: true });
    fixtures.push(serveOnly);
    const blockedContext = await englishContext(browser);
    contexts.push(blockedContext);
    const blockedPage = await blockedContext.newPage();
    blockedPage.setDefaultTimeout(15_000);
    blockedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(blockedPage, serveOnly.origin);
    const blockedGroup = blockedPage.locator('.settings-dialog [data-section="relay"]');
    const blockedToggle = blockedGroup.getByRole("switch", { name: "Ovis relay", exact: true });
    await blockedToggle.waitFor();
    assert.equal(await blockedToggle.isDisabled(), true, "a serve-only install cannot turn the relay on");
    assert.equal(await blockedToggle.getAttribute("aria-checked"), "false");
    await blockedGroup.locator(".relay-status").filter({ hasText: "Blocked: OVIS_TAILSCALE_SERVE_ONLY" }).waitFor();
    assert.equal(await blockedGroup.getByRole("img").count(), 0, "no offer on a blocked install");
    assert.equal(await blockedGroup.getByRole("button", { name: "Reset", exact: true }).count(), 0, "a serve-only install is offered no reset, which it would refuse");
    assert.equal(await blockedGroup.locator(".settings-condition").count(), 0, "a switch that cannot be turned on carries no note about turning it on");
    assert.deepEqual(pageErrors, [], "the relay panel raises no page error");
    console.log("PASS the relay panel turns the relay on and off, offers a QR code and resets the identity; serve-only blocks it and the shell hides it");
  } finally {
    for (const context of contexts) await context.close();
    for (const fixture of fixtures) await fixture.stop();
  }
}
