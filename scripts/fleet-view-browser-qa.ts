/**
 * The Fleet screen (todo 33 of the relay-fleet plan) in a real browser, against a real server whose fleet store holds
 * 100 machines: 93 active (three of them signed in on live machine sessions, through the relay's in-process carrier),
 * two batches of three waiting for confirmation, a slot on hold (a second key presented its invite) and an invite never
 * used. Every machine enrols for real (ENROLL on a machine session); nothing of the API is mocked. Run after `bun run
 * build` (`bun run check run --build bun scripts/fleet-view-browser-qa.ts` builds first).
 *
 *   happy    the screen at 1280 and 390 px in light and dark; scrolling the 100-machine list keeps frame time under
 *            50 ms at p95 and every row it draws shows a state word; Download invites hands over one archive and
 *            the page holds no secret of it; the owner confirms the first batch with the count and digest it showed
 *   failure  the slot on hold shows its alert, with no Confirm for it; a device paired to watch sees the batch with
 *            no Confirm, Remove or Download
 *   remote   a page whose every API request goes through a relay session of a device paired to drive (the server
 *            sees `via: relay`, role `drive`) opens the screen at 390 px, shows the second batch's count and
 *            fingerprints, and its Confirm makes the batch active
 *
 * UI_EVIDENCE_DIR=<dir> keeps the screenshots and the measurements there (default evidence/fleet-view).
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";
import { FLEET_CAUSE_SENTENCE } from "../shared/fleet-cause.ts";
import { mintRequest } from "../server/fleet/invites.ts";
import type { Invite } from "../server/fleet/invites.ts";
import { advertFrame, machineConnection, machineKey, testAdvert, turnFleetOn } from "../server/fleet/test-helpers.ts";
import { FLEET_TEST_TOKEN, fleetTestServer } from "../server/fleet/test-server.ts";
import { bounded, relayConnection, relayDevice } from "../server/relay/test-helpers.ts";
import { chromePath } from "./chrome-path.ts";

process.env["OVIS_FLEET_MAX"] = "200";
// the page opens the Fleet screen from Settings, whose entry the server's health shows only with the preview on
process.env["OVIS_PREVIEW"] = "fleet";
const evidence = process.env["UI_EVIDENCE_DIR"] || join(process.cwd(), "evidence/fleet-view");
mkdirSync(evidence, { recursive: true });
const report: Record<string, unknown> = {};
const pass = (line: string) => console.log(`PASS ${line}`);

const server = fleetTestServer();
const origin = `http://127.0.0.1:${server.app.port}`;
const relay = server.app.context.services.relay;
const fleet = relay.fleet;
turnFleetOn(server.stateDir);
fleet.start();
const keys = generateKeyPair();
const controller = { server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.example", direct: [] };
// minting through the page names this controller as a machine would reach it; the fixture has no relay link of its own
relay.fleetController = async () => controller;
const mint = async (count: number, prefix: string): Promise<readonly Invite[]> => (await fleet.invites.mint(mintRequest({ count, prefix }), async () => controller)).invites;
const session = () => machineConnection(server, fleet, { machineSessions: fleet, enrolment: fleet });

async function enrol(invite: Invite): Promise<string> {
  const key = await machineKey();
  const machine = await session();
  await machine.hello();
  await machine.enrollAndSignIn(key, invite);
  machine.stop();
  return key.id;
}

// 93 active machines, three of them signed in
const live: Awaited<ReturnType<typeof session>>[] = [];
for (let index = 0; index < 93; index++) {
  const key = await machineKey();
  fleet.store.add({ machine_id: key.id, public_key: key.spki, name: `vm-${String(index).padStart(3, "0")}`, slot: 1000 + index });
  fleet.store.setState(key.id, "active");
  if (index < 3) {
    const connection = await session();
    await connection.hello();
    await connection.signIn(key);
    connection.mux.enqueueControl(advertFrame({ ...testAdvert(), now: Math.floor(Date.now() / 1000) }));
    await bounded(connection.mux.measure());
    live.push(connection);
  }
}
// two batches of three waiting for confirmation
const first = await mint(3, "lab-");
const firstIds = await Promise.all(first.map(enrol));
const second = await mint(3, "gpu-");
const secondIds = await Promise.all(second.map(enrol));
// a slot on hold: its invite presented again by a second key; and one invite never used
const [stolen, unused] = await mint(2, "edge-");
await enrol(stolen!);
const thief = await session();
await thief.hello();
thief.sendEnroll(await machineKey(), stolen!);
await bounded(thief.error);
const onHold = fleet.store.machines().find((machine) => machine.state === "quarantined");
assert.ok(onHold, "the second key put the slot on hold");
assert.equal(fleet.store.machines().filter((machine) => machine.state !== "revoked").length, 100);
const batches = fleet.invites.batches();
assert.equal(batches.length, 2);
console.log(`fixture: 100 machines (93 active, 3 signed in, 6 waiting in 2 batches, 1 on hold), invite ${unused!.id} unused`);

const browser: Browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
const contexts: BrowserContext[] = [];
const errors: string[] = [];

async function open(width: 1280 | 390, theme: "light" | "dark", sign: (context: BrowserContext) => Promise<void>): Promise<Page> {
  const phone = width === 390;
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: phone ? 3 : 1,
    isMobile: phone, hasTouch: phone, colorScheme: theme, locale: "en-US", acceptDownloads: true,
  });
  contexts.push(context);
  await context.addInitScript((chosen) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: chosen })), theme);
  await sign(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?settings=devices&section=devices-more`);
  await page.locator(".settings-dialog").getByRole("button", { name: "Open fleet", exact: true }).click();
  await page.getByRole("dialog", { name: "Fleet", exact: true }).locator(".fleet-section").first().waitFor();
  // the sheet's rise (phone) and the first answers settle before anything is measured or captured
  await page.getByRole("heading", { name: /^Machines/ }).waitFor();
  await page.waitForFunction(() => document.querySelector(".fleet-view")!.closest(".modal-scrim")!.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"));
  return page;
}
const asOwner = async (context: BrowserContext) => { await context.request.post(`${origin}/api/auth`, { data: { token: FLEET_TEST_TOKEN } }); };
const asDevice = (role: "drive" | "watch") => async (context: BrowserContext) => {
  const devices = server.app.context.services.devices;
  const paired = devices.pair(devices.startPairing().code, `${role} QA device`, role);
  assert.ok(paired);
  await context.addCookies([{ name: "ovis_device", value: paired.token, url: origin, httpOnly: true, sameSite: "Strict" }]);
};
const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Fleet", exact: true });
const shot = async (page: Page, name: string) => { await dialogOf(page).screenshot({ path: join(evidence, `${name}.png`) }); };

try {
  // happy: the screen, captured at both widths in both themes
  for (const width of [1280, 390] as const) {
    for (const theme of ["light", "dark"] as const) {
      const page = await open(width, theme, asOwner);
      await shot(page, `fleet-${width}-${theme}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `no sideways scroll at ${width}`);
      if (width === 390 && theme === "light") {
        await page.locator(".fleet-list").scrollIntoViewIfNeeded();
        await shot(page, "fleet-390-light-list");
      }
      await page.context().close();
    }
  }
  pass("the Fleet screen captured at 1280 and 390 px, light and dark, with no sideways scroll");

  // happy: scrolling the 100 rows
  {
    const page = await open(1280, "light", asOwner);
    const measured = await page.evaluate(async () => {
      const body = document.querySelector<HTMLElement>(".fleet-view-body")!;
      const list = document.querySelector<HTMLElement>(".fleet-list")!;
      const max = body.scrollHeight - body.clientHeight;
      const deltas: number[] = [];
      const words = new Map<string, string>();
      let drawnMost = 0;
      let last = performance.now();
      for (let step = 0; step <= 160; step++) {
        body.scrollTop = Math.round((max * (step <= 80 ? step : 160 - step)) / 80);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        deltas.push(now - last);
        last = now;
        const rows = [...list.querySelectorAll<HTMLElement>(".fleet-row")];
        drawnMost = Math.max(drawnMost, rows.length);
        for (const row of rows) words.set(row.dataset["machineId"]!, row.querySelector(".fleet-state-word")?.textContent ?? "");
      }
      deltas.sort((a, b) => a - b);
      return { p95: deltas[Math.floor(deltas.length * 0.95)]!, worst: deltas.at(-1)!, frames: deltas.length, seen: words.size, blank: [...words.values()].filter((word) => word.trim() === "").length, drawnMost, words: [...new Set(words.values())].sort() };
    });
    report["scroll"] = measured;
    console.log(`scroll: ${JSON.stringify(measured)}`);
    assert.ok(measured.p95 < 50, `frame time p95 ${measured.p95} ms`);
    assert.equal(measured.seen, 100, "every machine's row was drawn while scrolling");
    assert.equal(measured.blank, 0, "every row shows a state word");
    assert.ok(measured.drawnMost < 100, "only the rows in view are drawn");
    pass(`100 machines scrolled at p95 ${measured.p95.toFixed(1)} ms per frame (worst ${measured.worst.toFixed(1)}), each of the 100 rows with a state word, at most ${measured.drawnMost} rows drawn at once`);

    // keyboard: Tab from the first row's Remove reaches every row's Remove in order, each inside the scroller's view,
    // then the mint form; Shift+Tab walks back the same way. Each step waits two frames, as a person's key presses do
    const frames = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const focused = () => page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const body = document.querySelector<HTMLElement>(".fleet-view-body")!.getBoundingClientRect();
      const box = active?.getBoundingClientRect();
      return {
        row: Number(active?.closest(".fleet-row")?.getAttribute("aria-posinset") ?? 0), remove: active?.classList.contains("fleet-row-remove") === true,
        mint: active?.closest(".fleet-mint") !== null && active?.closest(".fleet-mint") !== undefined,
        inView: box !== undefined && box.top >= body.top - 0.5 && box.bottom <= body.bottom + 0.5,
      };
    });
    await page.evaluate(() => { document.querySelector<HTMLElement>(".fleet-view-body")!.scrollTop = 0; });
    await frames();
    await dialogOf(page).locator('.fleet-row[aria-posinset="1"] .fleet-row-remove').focus();
    await frames();
    const walk = async (key: "Tab" | "Shift+Tab", from: number, to: number) => {
      const step = to > from ? 1 : -1;
      for (let row = from + step; row !== to + step; row += step) {
        await page.keyboard.press(key);
        await frames();
        const at = await focused();
        assert.deepEqual({ row: at.row, remove: at.remove, inView: at.inView }, { row, remove: true, inView: true }, `${key} to row ${row}`);
      }
    };
    assert.deepEqual(await focused(), { row: 1, remove: true, mint: false, inView: true });
    await walk("Tab", 1, 100);
    await page.keyboard.press("Tab");
    await frames();
    assert.equal((await focused()).mint, true, "Tab after the last row reaches the mint form");
    await page.keyboard.press("Shift+Tab");
    await frames();
    assert.deepEqual(await focused(), { row: 100, remove: true, mint: false, inView: true }, "Shift+Tab from the mint form comes back to the last row");
    await walk("Shift+Tab", 100, 1);
    // coming back in after the list was scrolled away: from the mint form with the list at its top, Shift+Tab lands on
    // the last row; from the control before the list with the list at its end, Tab lands on the first row
    const body = dialogOf(page).locator(".fleet-view-body");
    await body.evaluate((element) => { element.scrollTop = 0; });
    await frames();
    await dialogOf(page).getByLabel("Machines", { exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await frames();
    assert.deepEqual(await focused(), { row: 100, remove: true, mint: false, inView: true }, "Shift+Tab into a list scrolled to its top lands on the last row");
    const before = dialogOf(page).locator(".fleet-batch .fleet-confirm").last();
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await frames();
    await before.focus();
    await page.keyboard.press("Tab");
    await frames();
    assert.deepEqual(await focused(), { row: 1, remove: true, mint: false, inView: true }, "Tab into a list scrolled to its end lands on the first row");
    pass("Tab walks every one of the 100 rows' Remove in order, each in view, then the mint form; Shift+Tab walks back to the first row; coming back in from either side after scrolling away starts at that side's end");

    // Tab held down: key repeat about 30 ms apart walks the rows in order and stays in the dialog
    await body.evaluate((element) => { element.scrollTop = 0; });
    await frames();
    await dialogOf(page).locator('.fleet-row[aria-posinset="1"] .fleet-row-remove').focus();
    await frames();
    let held = 1;
    for (let press = 0; press < 40; press++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(30);
      const at = await focused();
      assert.equal(at.row, held + 1, `held Tab, press ${press + 1}: row ${at.row} after row ${held}`);
      held = at.row;
    }
    await frames();
    assert.deepEqual(await focused(), { row: 41, remove: true, mint: false, inView: true }, "held Tab settles on row 41 in view");
    pass("Tab held down (key repeat 30 ms apart) walks rows 2 to 41 in order and settles in view");

    // pointer: a click on a mid-list Remove, with the focus outside the list (the dialog itself, or the mint form),
    // opens that row's confirm dialog and the list does not move
    const clickRemove = async (row: number, focusFirst: () => Promise<void>, how: "click" | "tap", on: Page = page) => {
      const list = dialogOf(on).locator(".fleet-view-body");
      // the focus is put outside the list first (focusing the mint form scrolls to it), then the list is scrolled to the row
      await focusFirst();
      await list.evaluate((element, index) => {
        const host = element.querySelector<HTMLElement>(".fleet-list")!;
        const first = host.querySelector<HTMLElement>(".fleet-row")!;
        const top = host.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
        element.scrollTop = Math.max(0, top + (index - 1) * first.offsetHeight - element.clientHeight / 2);
      }, row);
      await on.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const button = dialogOf(on).locator(`.fleet-row[aria-posinset="${row}"] .fleet-row-remove`);
      const name = (await button.getAttribute("aria-label"))!.replace(/^Remove /, "");
      const scrolled = await list.evaluate((element) => element.scrollTop);
      if (how === "tap") await button.tap(); else await button.click();
      const confirm = on.getByRole("alertdialog", { name: `Remove ${name} from the fleet?`, exact: true });
      await confirm.waitFor({ timeout: 5_000 }).catch(async () => { throw new Error(`${how} on row ${row}'s Remove opened no confirm dialog (list at ${await list.evaluate((element) => element.scrollTop)}, was ${scrolled})`); });
      assert.equal(await list.evaluate((element) => element.scrollTop), scrolled, `${how} on row ${row}: the list did not move`);
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
    };
    await clickRemove(47, () => dialogOf(page).focus(), "click");
    await clickRemove(20, () => dialogOf(page).getByLabel("Machines", { exact: true }).focus(), "click");
    pass("a click on row 47's Remove (focus on the dialog) and on row 20's Remove (focus in the mint form) opens its confirm dialog, the list unmoved");
    const phone = await open(390, "light", asOwner);
    await clickRemove(28, () => dialogOf(phone).focus(), "tap", phone);
    pass("a 390 px tap on row 28's Remove opens its confirm dialog, the list unmoved");
    await phone.context().close();

    // happy: Download invites hands over one archive; the page keeps no secret of it
    const dialog = dialogOf(page);
    await dialog.getByLabel("Machines", { exact: true }).fill("2");
    await dialog.getByLabel("Name prefix", { exact: true }).fill("qa-");
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download invites", exact: true }).click()]);
    const saved = join(evidence, "downloaded-invites.zip");
    await download.saveAs(saved);
    const archive = readFileSync(saved);
    const secrets = [...archive.toString("latin1").matchAll(/"secret":"([A-Za-z0-9_-]{43})"/g)].map((match) => match[1]!);
    assert.equal(secrets.length, 2, "two invite files in the archive");
    assert.match(download.suggestedFilename(), /^ovis-invites-[0-9a-f]{16}\.zip$/);
    await dialog.getByText(/^2 invites saved as ovis-invites-/).waitFor();
    const html = await page.content();
    for (const secret of secrets) assert.equal(html.includes(secret), false, "no secret in the page");
    writeFileSync(saved, "");
    pass(`Download invites saved ${download.suggestedFilename()} with 2 invite files; the page holds neither secret`);
    await page.context().close();
  }

  // failure: the slot on hold, and a device that only watches
  {
    const page = await open(1280, "light", asOwner);
    const alert = dialogOf(page).locator(".fleet-on-hold[role=alert]");
    const text = await alert.innerText();
    assert.ok(text.includes(onHold.name) && text.includes(FLEET_CAUSE_SENTENCE.quarantined), `alert text: ${text}`);
    assert.equal(await alert.getByRole("button", { name: /^Confirm/ }).count(), 0, "no Confirm for the slot on hold");
    for (const batch of await dialogOf(page).locator(".fleet-batch").all()) assert.equal((await batch.innerText()).includes(onHold.name), false);
    await alert.scrollIntoViewIfNeeded();
    await shot(page, "fleet-on-hold-1280-light");
    report["onHoldAlert"] = text;
    pass(`the slot on hold shows "${text.split("\n")[0]}" with no Confirm of its own`);
    await page.context().close();

    const watcher = await open(390, "light", asDevice("watch"));
    const dialog = dialogOf(watcher);
    assert.equal(await dialog.locator(".fleet-batch").count(), 2);
    assert.ok((await dialog.locator(".fleet-batch").first().innerText()).includes(batches[0]!.machines[0]!.fingerprint));
    assert.equal(await dialog.getByRole("button", { name: /^Confirm/ }).count(), 0, "no Confirm for a watching device");
    assert.equal(await dialog.getByRole("button", { name: /^Remove/ }).count(), 0, "no Remove for a watching device");
    assert.equal(await dialog.getByRole("button", { name: "Download invites" }).count(), 0, "no Download for a watching device");
    await dialog.locator("[data-fleet-watching]").waitFor();
    await shot(watcher, "fleet-watch-390-light");
    pass("a device paired to watch sees both batches and their fingerprints with no Confirm, Remove or Download");
    await watcher.context().close();
  }

  // happy: the owner confirms the first batch
  {
    const page = await open(1280, "light", asOwner);
    const card = dialogOf(page).locator(`.fleet-batch[data-batch-id="${batches[0]!.batch_id}"]`);
    assert.ok((await card.innerText()).includes("3 machines joined"));
    await shot(page, "fleet-confirm-before-1280-light");
    await card.getByRole("button", { name: "Confirm 3 machines", exact: true }).click();
    await dialogOf(page).getByText("3 machines confirmed.", { exact: true }).waitFor();
    for (const id of firstIds) assert.equal(fleet.store.get(id)?.state, "active");
    for (const id of secondIds) assert.equal(fleet.store.get(id)?.state, "pending");
    await dialogOf(page).locator(".fleet-batch").nth(0).waitFor();
    assert.equal(await dialogOf(page).locator(".fleet-batch").count(), 1);
    await shot(page, "fleet-confirm-after-1280-light");
    pass("the owner's Confirm made exactly the first batch's three machines active");
    await page.context().close();
  }

  // remote: a device paired to drive, every API request through a relay session
  {
    const link = await relayConnection(server);
    await link.auth(await relayDevice(server, "drive"));
    const through: string[] = [];
    const page = await (async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light", locale: "en-US" });
      contexts.push(context);
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light" })));
      // a few requests at a time on the relay session, within its stream budget; event streams are not the screen's
      const waiting: (() => void)[] = [];
      let running = 0;
      const slot = async (): Promise<void> => { if (running >= 3) await new Promise<void>((resolve) => waiting.push(resolve)); running++; };
      const done = (): void => { running--; waiting.shift()?.(); };
      await context.route(`${origin}/api/**`, async (route) => {
        const request = route.request();
        // the shell's file icons and worktree lists are not the screen's: kept off the test link, whose stream budget they would spend
        const path = new URL(request.url()).pathname;
        if ((request.headers()["accept"] ?? "").includes("text/event-stream") || path.startsWith("/api/fs/") || path.startsWith("/api/worktree/")) { await route.abort(); return; }
        await slot();
        try {
          const url = new URL(request.url());
          const headers = Object.entries(request.headers()).filter(([name]) => ["content-type", "x-herdr-update", "accept"].includes(name)) as [string, string][];
          const body = request.postDataBuffer();
          try {
            const opened = link.open(url.pathname + url.search, { method: request.method(), headers, body: body === null ? "none" : "stream" });
            if (body !== null) void opened.stream.sendBody(new Response(body).body ?? new ReadableStream()).catch(() => {});
            const response = await opened.response;
            through.push(`${request.method()} ${url.pathname} ${response.status}`);
            await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
          } catch (error) {
            through.push(`${request.method()} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
            await route.abort().catch(() => {});
          }
        } finally {
          done();
        }
      });
      const opened = await context.newPage();
      opened.setDefaultTimeout(20_000);
      opened.on("pageerror", (error) => errors.push(error.message));
      await opened.goto(`${origin}/?settings=devices&section=devices-more`);
      await opened.locator(".settings-dialog").getByRole("button", { name: "Open fleet", exact: true }).click();
      await opened.getByRole("heading", { name: /^Machines/ }).waitFor().catch(async (error: unknown) => {
        await opened.screenshot({ path: join(evidence, "fleet-remote-stalled.png") });
        console.log(`relayed requests so far: ${JSON.stringify(through)}`);
        throw error;
      });
      await opened.waitForFunction(() => document.querySelector(".fleet-view")!.closest(".modal-scrim")!.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"));
      return opened;
    })();
    const health = await page.evaluate(async () => (await (await fetch("/api/health")).json()).auth);
    assert.deepEqual({ via: health.via, role: health.role }, { via: "relay", role: "drive" }, "the page is a device paired to drive, through the relay");
    const card = dialogOf(page).locator(`.fleet-batch[data-batch-id="${batches[1]!.batch_id}"]`);
    const shown = await card.innerText();
    assert.ok(shown.includes("3 machines joined"));
    for (const machine of batches[1]!.machines) assert.ok(shown.includes(machine.fingerprint), `fingerprint ${machine.fingerprint} shown`);
    await card.scrollIntoViewIfNeeded();
    await shot(page, "fleet-remote-drive-390-light");
    await card.getByRole("button", { name: "Confirm 3 machines", exact: true }).click();
    await dialogOf(page).getByText("3 machines confirmed.", { exact: true }).waitFor();
    for (const id of secondIds) assert.equal(fleet.store.get(id)?.state, "active");
    const confirmed = through.find((line) => line.startsWith("POST /api/fleet/batches/"));
    assert.equal(confirmed, `POST /api/fleet/batches/${batches[1]!.batch_id}/confirm 200`);
    report["remote"] = { health, confirmed, requests: through.length };
    pass(`a device paired to drive, through the relay at 390 px, read the batch's count and fingerprints and confirmed it (${confirmed})`);
    await page.context().close();
  }

  assert.deepEqual(errors, [], "no page error");
  writeFileSync(join(evidence, "fleet-view-qa.json"), JSON.stringify(report, null, 2));
  console.log("PASS every Fleet screen check");
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const connection of live) connection.stop();
  thief.stop();
  await fleet.close();
  server.close();
}
process.exit(0);
