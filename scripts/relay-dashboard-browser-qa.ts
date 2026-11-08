/**
 * The hosted relay app's dashboard against the acceptance matrix (plan relay-console-polish todo 11): every state of
 * the matrix that a fixture fleet reaches, each judged by what the page computes (counts, routes, rectangles, focus,
 * animations), never by a picture. The shell is the real build served as Cloudflare Pages serves it, under its
 * enforced policy, on https://app.ovis.sh (routed here); the account service is the in-memory fake
 * (shared/account-service-fake.ts) with the directory answered from scripts/relay-dashboard-fixtures.ts. No relay,
 * PC or herdr takes part: every WebSocket the page opens is closed at once, so this device's own checks of its
 * pairings end unanswered. The states that need a real PC (pairing, approval, updates) are relay-shell-browser-qa's.
 *
 *   bun scripts/relay-dashboard-browser-qa.ts                     # builds the shell itself
 *   ONLY='^(table|overview)' UI_EVIDENCE_DIR=<dir> bun scripts/relay-dashboard-browser-qa.ts
 *
 * relay-shell-browser-qa.ts calls `relayDashboardQa` with its own browser and shell host. Each check prints PASS or
 * FAIL with what it measured; any FAIL fails the run after every selected check ran.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page, Route } from "playwright-core";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { chromePath } from "./chrome-path.ts";
import { assertCspClean, watchCsp } from "./csp-violations.ts";
import type { CspWatch } from "./csp-violations.ts";
import { servePagesSite } from "./pages-static.ts";
import { ACCOUNT, directoryOf, fleetOf, LONG_NAME, seedPairings } from "./relay-dashboard-fixtures.ts";
import type { Fleet, FleetName } from "./relay-dashboard-fixtures.ts";

const APP = "https://app.ovis.sh";
const ACCOUNT_SERVICE = "https://account.ovis.sh";
const LOAD_MS = 45_000;

export interface DashboardQaOptions {
  readonly browser: Browser;
  /** where the built shell is served (http://127.0.0.1:<port>); app.ovis.sh is routed there */
  readonly origin: string;
  readonly evidence: string | null;
}

type Width = 390 | 1440 | 1920;
interface OpenOptions {
  readonly fleet: FleetName;
  readonly width?: Width;
  readonly theme?: "dark" | "light";
  readonly density?: "comfortable" | "compact";
  readonly signedIn?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
  /** answers GET /v1/pcs instead of the fleet's directory (held, failed) once the dashboard is up */
  readonly directory?: (route: Route) => Promise<void> | void;
  /** before the first load: routes of the check's own */
  readonly prepare?: (context: BrowserContext) => Promise<void>;
  /** where the page is left: the dashboard (default), the sign-in's providers, or any shell screen */
  readonly entry?: "dashboard" | "providers" | "screen";
}
interface Opened { readonly context: BrowserContext; readonly page: Page; readonly fleet: Fleet; readonly sockets: string[]; readonly errors: string[]; readonly account: string[] }

const HEIGHT: Record<Width, number> = { 390: 844, 1440: 900, 1920: 1080 };

export async function relayDashboardQa({ browser, origin, evidence }: DashboardQaOptions): Promise<string[]> {
  if (evidence) mkdirSync(evidence, { recursive: true });
  const only = process.env["ONLY"] ? new RegExp(process.env["ONLY"]) : null;
  const report: string[] = [];
  const failed: string[] = [];
  const csp: CspWatch[] = [];
  const contexts: BrowserContext[] = [];
  /** the pages the running check opened: each must end with no page error and no request off app.ovis.sh and account.ovis.sh */
  const opened: Opened[] = [];

  const open = async (options: OpenOptions): Promise<Opened> => {
    const width = options.width ?? 1440;
    const phone = width < 600;
    const fleet = fleetOf(options.fleet);
    const fake = new FakeAccountService();
    const context = await browser.newContext({
      viewport: { width, height: HEIGHT[width] }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone,
      colorScheme: options.theme ?? "dark", reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
      forcedColors: options.forcedColors ? "active" : "none", serviceWorkers: "block",
    });
    contexts.push(context);
    const sockets: string[] = [];
    const errors: string[] = [];
    const account: string[] = [];
    await context.route(/.*/, async (route) => { errors.push(`unexpected request ${route.request().url()}`); await route.abort(); });
    let closing = false;
    context.on("close", () => { closing = true; });
    await context.route(/^https:\/\/app\.ovis\.sh\//, async (route) => {
      const url = new URL(route.request().url());
      // a check that closes its context while the page still loads ends this request with it
      await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) }).catch((error: unknown) => { if (!closing) throw error; });
    });
    let directory: OpenOptions["directory"] | null = null;
    await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
      account.push(`${request.method()} ${path}`);
      if (request.method() === "GET" && path === "/v1/pcs" && request.headers()["authorization"] !== undefined) {
        if (directory) { await directory(route); return; }
        await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ pcs: directoryOf(fleet, Date.now()) }) });
        return;
      }
      const body = request.postDataBuffer();
      const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body }) }));
      const location = answer.headers.get("location");
      // the sign-in's way back is a new navigation, which the app.ovis.sh route serves (a fulfilled redirect would leave the routes)
      if (answer.status === 302 && location !== null && location.startsWith(`${APP}/`)) {
        await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
        return;
      }
      await route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
    });
    await context.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close(); });
    await context.addInitScript(({ theme, density }) => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, density }));
    }, { theme: options.theme ?? "dark", density: options.density ?? "comfortable" });
    await options.prepare?.(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    const made: Opened = { context, page, fleet, sockets, errors, account };
    opened.push(made);
    csp.push(await watchCsp(page));
    await page.goto(`${APP}/`);
    if (options.entry === "screen") { await page.locator("main[data-relay-state]").first().waitFor({ timeout: LOAD_MS }); return made; }
    await page.locator(".account-provider").first().waitFor({ timeout: LOAD_MS });
    if (options.entry === "providers") return made;
    const settle = async (mode: "account" | "local"): Promise<void> => {
      await page.locator(`.relay-dash[data-dashboard-mode="${mode}"]`).waitFor({ timeout: LOAD_MS });
      await page.locator(".relay-overview-strip button, [data-dashboard-empty]").first().waitFor({ timeout: LOAD_MS });
      await page.waitForFunction(() => document.querySelectorAll('.status-dot[data-state="checking"]').length === 0, null, { timeout: LOAD_MS });
    };
    if (options.signedIn ?? true) {
      await page.getByRole("button", { name: "Continue with GitHub" }).click();
      await page.locator('.relay-dash[data-dashboard-mode="account"]').waitFor({ timeout: LOAD_MS });
      if (fleet.seeds.length > 0) {
        await seedPairings(page, fleet.seeds, ACCOUNT);
        await page.reload();
      }
      directory = options.directory ?? null;
      if (options.directory) { await page.reload(); return made; }
      await settle("account");
    } else {
      await seedPairings(page, fleet.seeds, null);
      await page.reload();
      await page.locator('[data-action="continue-local"], .account-continue-saved').first().click();
      await settle("local");
    }
    return made;
  };

  /** Runs one check of the matrix: PASS with what it measured, or FAIL with why; the run goes on either way. */
  const check = async (name: string, run: () => Promise<string>): Promise<void> => {
    if (only && !only.test(name)) return;
    const started = Date.now();
    try {
      const measured = await run();
      const heard = opened.flatMap((page) => page.errors);
      if (heard.length > 0) throw new Error(`the pages heard ${JSON.stringify(heard.slice(0, 3))}`);
      report.push(`PASS ${name}: ${measured} (${Date.now() - started} ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
      failed.push(name);
      report.push(`FAIL ${name}: ${message}`);
    } finally {
      opened.splice(0);
      for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
    }
    console.log(report.at(-1));
  };
  const expect = (holds: boolean, what: string): void => { if (!holds) throw new Error(what); };
  const shot = async (page: Page, name: string, fullPage = false): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage }); };
  const noOverflow = async (page: Page): Promise<string> => {
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll <= size.client, `horizontal overflow: scrollWidth ${size.scroll} > clientWidth ${size.client}`);
    return `scrollWidth ${size.scroll} <= ${size.client}`;
  };
  const go = async (page: Page, hash: string, view: string): Promise<void> => {
    await page.evaluate((target) => { location.hash = target; }, hash);
    await page.locator(`.relay-dash[data-dashboard-view="${view}"]`).waitFor();
  };
  /** The strip's cells as the page counts them: data-strip-count and the offline note on Needs you. */
  const strip = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".relay-overview-strip [data-strip-cell]")]
    .map((cell) => [cell.dataset["stripCell"], { count: Number(cell.dataset["stripCount"]), offline: cell.dataset["stripOffline"] === undefined ? null : Number(cell.dataset["stripOffline"]) }])));
  const listedRows = (page: Page) => page.locator("[data-pc-list] [data-pc-id]");
  /** The height most rows of the PC table share (rows with a second line may grow). */
  const tableGeometry = (page: Page) => page.evaluate(() => {
    // a row's height without the hairline that parts it from the next one
    const heights = [...document.querySelectorAll<HTMLElement>('[data-pc-list="table"] tbody tr')].map((row) => {
      const cell = row.querySelector("td");
      return Math.round(row.getBoundingClientRect().height - (cell ? parseFloat(getComputedStyle(cell).borderBottomWidth) : 0));
    });
    const tally = new Map<number, number>();
    for (const height of heights) tally.set(height, (tally.get(height) ?? 0) + 1);
    const common = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const head = document.querySelector<HTMLElement>('[data-pc-list="table"] thead th');
    return { rows: heights.length, common, min: Math.min(...heights), head: head ? Math.round(head.getBoundingClientRect().height) : 0 };
  });
  const disclosureHeight = (page: Page) => page.locator('[data-action="open-connection-map"]').evaluate((element) => element.getBoundingClientRect().height);

  // ---- sign-in (todo 4): an unboxed 368px column, 44px provider controls of one height ----

  for (const width of [1440, 390] as const) {
    await check(`signin-${width}`, async () => {
      const { page, account } = await open({ fleet: "F0", width, theme: "light", entry: "providers" });
      const column = await page.locator(".account-centered").first().evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: element.getBoundingClientRect().width, border: style.borderTopWidth, background: style.backgroundColor };
      });
      const providers = await page.locator(".account-provider").evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)));
      expect(width === 1440 ? Math.round(column.width) === 368 : column.width <= 368, `sign-in column ${column.width}px (368px at most, 368 on a desktop)`);
      expect(column.border === "0px" && column.background === "rgba(0, 0, 0, 0)", `sign-in column is unboxed (border ${column.border}, background ${column.background})`);
      expect(providers.length > 0 && providers.every((height) => height === providers[0]) && (providers[0] ?? 0) >= 44, `provider controls ${JSON.stringify(providers)}px: one height, at least 44`);
      // V-071: the providers are the build's, known at first paint; nothing asked afterwards can add one under a finger
      expect(!account.includes("GET /v1/providers"), "the sign-in asks the service for no provider list after it painted");
      expect(await page.locator(".account-provider").count() === providers.length, "the provider stack did not change while measured");
      await shot(page, `signin-${width}-light`);
      return `column ${Math.round(column.width)}px unboxed, providers ${JSON.stringify(providers)}px, ${await noOverflow(page)}`;
    });
  }

  await check("signin-error", async () => {
    const { page } = await open({
      fleet: "F0", entry: "providers",
      prepare: async (context) => {
        await context.route(/^https:\/\/account\.ovis\.sh\/v1\/token$/, (route) => route.fulfill({
          status: 400, contentType: "application/json", headers: { "access-control-allow-origin": APP }, body: JSON.stringify({ error: "invalid_grant", message: "The code is wrong, spent or expired" }),
        }));
      },
    });
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.locator('[data-account-state="signed-out"] [role=alert]').waitFor();
    const retry = page.locator('[data-action="retry-signin"]');
    expect(await retry.count() === 1, "a failed sign-in offers Try again");
    expect(await page.locator(".account-provider").count() > 0, "the providers stay offered after the failure");
    await shot(page, "signin-error-1440-dark");
    return "alert beside the providers, Try again, providers kept";
  });

  await check("signin-no-service", async () => {
    const { page } = await open({
      fleet: "F0", entry: "screen",
      prepare: async (context) => {
        await context.route(/^https:\/\/app\.ovis\.sh\/(index\.html)?(\?.*)?$/, async (route) => {
          const url = new URL(route.request().url());
          const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}` });
          await route.fulfill({ response, body: (await response.text()).replace(/<meta name="ovis-account-service"[^>]*>/, "") });
        });
      },
    });
    expect(await page.locator(".account-provider").count() === 0, "no sign-in provider without an account service");
    return `screen ${await page.locator("main[data-relay-state]").first().getAttribute("data-relay-state")}, 0 providers`;
  });

  // ---- truthful counts (todo 2) and the overview (todo 9) ----

  const counts: [FleetName, number, number, number][] = [["F4", 0, 4, 1], ["FREADY", 3, 3, 1], ["F20", 8, 12, 4]];
  for (const [fleet, ready, needs, offline] of counts) {
    await check(`dashboard-${fleet}-counts`, async () => {
      const { page } = await open({ fleet });
      const cells = await strip(page);
      expect(cells["ready"]?.count === ready && cells["needs"]?.count === needs && cells["needs"]?.offline === offline,
        `strip ${JSON.stringify(cells)}: want Ready ${ready}, Needs you ${needs} incl. ${offline} offline`);
      const attention = await page.locator(".relay-overview-attention-row").count();
      expect(attention === Math.min(3, needs), `attention rows ${attention}: at most three`);
      const all = page.locator('[data-action="view-all-attention"]');
      expect(needs > 3 ? await all.getAttribute("data-attention-total") === String(needs) : await all.count() === 0, `View all ${needs > 3 ? `says ${needs}` : "absent"}`);
      await shot(page, `dashboard-${fleet}-1440-dark`, true);
      return `Ready ${ready}, Needs you ${needs} (incl. ${offline} offline), attention ${attention}${needs > 3 ? ` + View all ${needs}` : ""}`;
    });
  }

  await check("dashboard-F20-eight-rows", async () => {
    const { page } = await open({ fleet: "F20" });
    await page.evaluate(() => window.scrollTo(0, 0));
    const complete = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-pc-list="table"] tbody tr')]
      .filter((row) => { const box = row.getBoundingClientRect(); return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight; }).length);
    await shot(page, "dashboard-F20-1440-dark-viewport");
    expect(complete >= 8, `${complete} complete PC rows in the 1440x900 first viewport, want 8`);
    return `${complete} complete rows in the first viewport`;
  });

  await check("dashboard-F0", async () => {
    const { page } = await open({ fleet: "F0" });
    const empty = page.locator("[data-dashboard-empty]");
    expect(await empty.locator(".btn-primary").count() === 1, "the zero-PC view has one primary");
    expect(await empty.locator('.btn-primary[data-action="add-pc"]').count() === 1, "its primary is Add a PC");
    expect(await empty.locator('[data-action="pair-qr"]:not(.btn-primary)').count() === 1, "Pair with a QR or code is the secondary");
    expect(await page.locator(".relay-overview-strip").count() === 0, "no count strip without PCs");
    return "one Add a PC primary, QR secondary, no strip";
  });

  for (const density of ["comfortable", "compact"] as const) {
    await check(`overview-disclosure-${density}`, async () => {
      const { page } = await open({ fleet: "FREADY", density });
      const height = await disclosureHeight(page);
      expect(height >= 44, `Connection map disclosure ${height}px in ${density} density, want at least 44`);
      await page.locator('[data-action="open-connection-map"]').click();
      await page.locator('.relay-dash[data-dashboard-view="relay"]').waitFor();
      return `${height}px, opens #relay`;
    });
  }

  await check("overview-section-spacing", async () => {
    const { page } = await open({ fleet: "FREADY" });
    const gaps = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(`.relay-overview > ${selector}`)?.getBoundingClientRect() ?? null;
      const strip = box(".relay-overview-strip"), relays = box(".relay-overview-relays"), attention = box(".relay-overview-attention-section");
      const table = box("#relay-dash-pcs"), disclosure = box(".relay-overview-map-disclosure");
      if (!strip || !attention || !table || !disclosure) return null;
      const summaryBottom = Math.max(strip.bottom, relays?.bottom ?? 0);
      return { "summary-attention": attention.top - summaryBottom, "attention-table": table.top - attention.bottom, "table-disclosure": disclosure.top - table.bottom };
    });
    expect(gaps !== null, "the overview's summary, attention list, table and disclosure are all there");
    const short = Object.entries(gaps ?? {}).filter(([, gap]) => gap < 24);
    expect(short.length === 0, `gaps between the overview's major sections ${JSON.stringify(gaps)}: each at least 24px`);
    return JSON.stringify(gaps);
  });

  await check("dashboard-FLONG", async () => {
    const results: string[] = [];
    for (const width of [1440, 390] as const) {
      const { page } = await open({ fleet: "FLONG", width });
      results.push(`${width}: ${await noOverflow(page)}`);
      const cut = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".relay-pc-name-label, .relay-overview-attention-name")]
        .filter((label) => label.scrollWidth > label.clientWidth + 1)
        .filter((label) => (label.closest("[title]")?.getAttribute("title") ?? "") !== label.textContent).map((label) => label.textContent));
      expect(cut.length === 0, `${width}: names cut without their full name to hand ${JSON.stringify(cut)}`);
      expect(await page.locator(`[title="${LONG_NAME}"]`).count() > 0, `${width}: the long name is in a title`);
      await shot(page, `dashboard-FLONG-${width}-dark`, true);
      await page.context().close();
    }
    return results.join("; ");
  });

  await check("local-dashboard", async () => {
    const { page } = await open({ fleet: "FREADY", signedIn: false });
    const keys = await page.locator(".relay-overview-strip [data-strip-cell]").evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-strip-cell")));
    expect(JSON.stringify(keys) === JSON.stringify(["paired", "relays"]), `local strip ${JSON.stringify(keys)}: no account Ready/Needs you`);
    const words = await page.locator(".relay-overview-local-row .relay-overview-attention-why").allInnerTexts();
    expect(words.length > 0 && words.every((word) => /^(Paired · not checked|This device: .+)$/.test(word)), `local rows report this device's checks only ${JSON.stringify(words)}`);
    return `strip ${JSON.stringify(keys)}, rows ${JSON.stringify([...new Set(words)])}`;
  });

  // ---- filters (todos 2, 7): the Needs filter lists what the strip counts ----

  const filters: [string, FleetName, string, number][] = [["filter-needs", "FREADY", "needs", 3], ["filter-ready", "FREADY", "ready", 3], ["filter-offline", "FREADY", "offline", 1], ["filter-empty", "F4", "ready", 0]];
  for (const [name, fleet, filter, want] of filters) {
    await check(name, async () => {
      const { page } = await open({ fleet });
      const strip0 = await strip(page);
      await go(page, `#pcs?filter=${filter}`, "pcs");
      const rows = await listedRows(page).count();
      expect(rows === want, `${rows} rows under ${filter}, want ${want}`);
      if (filter === "needs") expect(rows === strip0["needs"]?.count, `Needs you rows ${rows} = strip ${strip0["needs"]?.count}`);
      if (want === 0) {
        expect(await page.locator("[data-filter-empty]").count() === 1, "an empty filter says so");
        expect(await page.getByRole("button", { name: "Show all PCs" }).count() === 1, "and offers all PCs");
      }
      // the status line gets its words the frame after it mounts (useAnnouncedText), so a newly shown list is announced
      const words = want === 0 ? "No PC matches this filter." : want === 1 ? "1 PC shown" : `${want} PCs shown`;
      const status = page.locator('.relay-pc-list-region [role="status"]');
      await page.waitForFunction(({ words }) => document.querySelector('.relay-pc-list-region [role="status"]')?.textContent === words, { words }).catch(() => undefined);
      const said = await status.innerText();
      expect(said === words, `the filter announces "${said}", want "${words}"`);
      return `${rows} rows, announced "${said}"`;
    });
  }

  // ---- the PC table (todo 7): 44px rows, 40px compact, 36px header; Details in the page ----

  for (const [density, rowHeight] of [["comfortable", 44], ["compact", 40]] as const) {
    await check(`table-rows-${density}`, async () => {
      const { page } = await open({ fleet: "FREADY", density });
      await go(page, "#pcs", "pcs");
      const geometry = await tableGeometry(page);
      expect(geometry.common === rowHeight && geometry.min >= rowHeight, `rows ${JSON.stringify(geometry)}: want ${rowHeight}px rows, none shorter`);
      expect(geometry.head === 36, `header ${geometry.head}px, want 36`);
      return JSON.stringify(geometry);
    });
  }

  await check("details", async () => {
    const { page, sockets } = await open({ fleet: "FREADY" });
    await go(page, "#pcs", "pcs");
    const before = sockets.length;
    await listedRows(page).filter({ hasText: "Home server" }).locator('[data-pc-action="details"]').click();
    await page.locator("[data-pc-details]").waitFor();
    const where = await page.evaluate(() => ({ path: location.pathname, hash: location.hash }));
    expect(where.path === "/" && /[?&]pc=/.test(where.hash), `Details stays in the page (${JSON.stringify(where)})`);
    expect(sockets.length === before, `Details opened ${sockets.length - before} sockets`);
    await shot(page, "details-1440-dark");
    return `${where.hash}, no socket`;
  });

  await check("details-unknown", async () => {
    const { page } = await open({ fleet: "FUNKNOWN" });
    await go(page, "#pcs", "pcs");
    await listedRows(page).filter({ hasText: "Spare desktop" }).locator(".relay-pc-name-btn").click();
    const text = await page.locator("[data-pc-details]").innerText();
    expect(!/Invalid Date|NaN|undefined|null/.test(text), `Details of a never-seen PC shows no broken value: ${JSON.stringify(text)}`);
    return "no Invalid Date, NaN, undefined or null";
  });

  // ---- the frame (todo 6): five real destinations, Back, widths ----

  await check("routes", async () => {
    const { page } = await open({ fleet: "FREADY" });
    expect(await page.locator(".relay-dash-nav [aria-disabled]").count() === 0, "no disabled destination");
    const views = ["pcs", "devices", "relay", "settings", "overview"];
    for (const view of views) {
      await page.locator(`.relay-dash-nav a[href="#${view}"]`).click();
      await page.locator(`.relay-dash[data-dashboard-view="${view}"]`).waitFor();
      expect(await page.locator(`.relay-dash-nav a[href="#${view}"]`).getAttribute("aria-current") === "page", `${view} is the current item`);
      expect((await page.evaluate(() => location.hash)).startsWith(`#${view}`), `${view} is in the address`);
    }
    await page.goBack();
    await page.locator('.relay-dash[data-dashboard-view="settings"]').waitFor();
    await page.goBack();
    await page.locator('.relay-dash[data-dashboard-view="relay"]').waitFor();
    const side = await page.locator(".relay-dash-side").evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.round(side) === 240, `sidebar ${side}px, want 240`);
    return `${views.join(" > ")}, Back > settings > relay, sidebar ${side}px`;
  });

  await check("frame-widths", async () => {
    const wide = await open({ fleet: "F20", width: 1920 });
    const content = await wide.page.locator(".relay-dash-content").evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.round(content) === 1280, `content ${content}px at 1920, want the 1280 cap`);
    await wide.context.close();
    const { page } = await open({ fleet: "F20", width: 390 });
    const gutter = await page.locator(".relay-dash-content").evaluate((element) => getComputedStyle(element).paddingLeft);
    expect(gutter === "16px", `phone gutter ${gutter}, want 16px`);
    await go(page, "#pcs", "pcs");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const clear = await page.evaluate(() => {
      const rows = document.querySelectorAll("[data-pc-list] [data-pc-id]");
      const last = rows[rows.length - 1]?.getBoundingClientRect();
      const bar = document.querySelector(".relay-dash-tabs")?.getBoundingClientRect();
      return last && bar ? { last: last.bottom, bar: bar.top } : null;
    });
    expect(clear !== null && clear.last <= clear.bar, `the last row clears the tab bar at the end (${JSON.stringify(clear)})`);
    await shot(page, "tab-pcs-390-dark-end");
    return `content 1280 at 1920, phone gutter 16px, last row ${JSON.stringify(clear)}`;
  });

  // ---- the connection map (todo 8): a diagram for <= 8 PCs on a wide screen, a list otherwise; no particles ----

  for (const [fleet, width, diagram] of [["FREADY", 1440, true], ["FREADY", 390, false], ["F20", 1440, false]] as const) {
    await check(`tab-relay-${fleet}-${width}`, async () => {
      const { page } = await open({ fleet, width });
      await go(page, "#relay", "relay");
      const map = await page.evaluate(() => ({
        diagram: document.querySelector(".relay-map")?.getAttribute("data-diagram"),
        drawn: [...document.querySelectorAll<HTMLElement>(".relay-map-diagram")].filter((diagram) => diagram.getBoundingClientRect().height > 0).length,
        routeLists: document.querySelectorAll("ol.relay-map-routes").length,
        particles: document.querySelectorAll(".relay-map-dot").length,
        endless: document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations === Infinity).length,
      }));
      // narrow screens hide a diagram the layout made (data-diagram stays "true"): what counts is what is drawn
      expect(map.drawn === (diagram ? 1 : 0), `diagram ${JSON.stringify(map)}: want ${diagram ? "drawn" : "the list alone"}`);
      expect(map.routeLists === 1, `${map.routeLists} route lists, want 1`);
      expect(map.particles === 0 && map.endless === 0, `nothing moves on a map no check runs on ${JSON.stringify(map)}`);
      await shot(page, `tab-relay-${fleet}-${width}-dark`);
      return JSON.stringify(map);
    });
  }

  // ---- feedback states (todo 9): loading holds its shape, a directory failure keeps what is known ----

  await check("dashboard-loading", async () => {
    const held: Route[] = [];
    const { page } = await open({ fleet: "FREADY", directory: (route) => { held.push(route); } });
    await page.locator("[data-dashboard-loading]").waitFor();
    const slots = await page.evaluate(() => ({
      strip: document.querySelectorAll('[data-dashboard-loading] [data-loading-slot="strip-numeral"]').length,
      rows: document.querySelectorAll('[data-dashboard-loading] [data-loading-slot="table-row"]').length,
    }));
    await shot(page, "dashboard-loading-1440-dark");
    for (const route of held) await route.abort().catch(() => undefined);
    expect(slots.strip === 3 && slots.rows === 4, `loading reserves ${JSON.stringify(slots)}: want the 3 strip cells and 4 rows`);
    return JSON.stringify(slots);
  });

  await check("dashboard-directory-error", async () => {
    const { page, fleet } = await open({ fleet: "FREADY", directory: (route) => route.fulfill({ status: 503, headers: { "access-control-allow-origin": APP }, contentType: "application/json", body: JSON.stringify({ error: "unavailable", message: "Directory down" }) }) });
    await page.locator("[data-directory-error]").waitFor({ timeout: LOAD_MS });
    expect(await page.locator('[data-directory-error] [data-action="retry-directory"]').count() === 1, "the failure offers Try again");
    const known = fleet.seeds.map((seed) => seed.server_id);
    const shown = await listedRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-pc-id")));
    const lost = known.filter((id) => !shown.includes(id));
    await shot(page, "dashboard-directory-error-1440-dark", true);
    expect(lost.length === 0, `the PCs this device holds stay listed through the failure (${lost.length} of ${known.length} gone)`);
    return `alert + Try again, ${known.length} known rows kept`;
  });

  // ---- devices (todo 6) ----

  await check("device-remove-confirm", async () => {
    const { page, account } = await open({ fleet: "FREADY" });
    await go(page, "#devices", "devices");
    await page.locator('[data-action="remove-device"]').click();
    await page.locator('[data-confirm="remove-device"]').waitFor();
    expect(!account.some((line) => line.startsWith("DELETE")), "the first press only asks");
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await page.locator('[data-confirm="remove-device"]').count() === 0, "Cancel takes the question back");
    return "asks first, Cancel reverts, nothing deleted";
  });

  // ---- large fleets (todo 7) ----

  for (const [fleet, total] of [["FLEET200", 200], ["FLEET1000", 1000]] as const) {
    await check(`fleet-${total}`, async () => {
      const { page } = await open({ fleet });
      const cells = await strip(page);
      await go(page, "#pcs", "pcs");
      const rows = await listedRows(page).count();
      expect(rows === total, `${rows} rows, want ${total}`);
      expect(await page.locator(".relay-pc-list-region.is-large-fleet").count() === 1, "the large-fleet table");
      return `${rows} rows, strip ${JSON.stringify(cells)}, ${await noOverflow(page)}`;
    });
  }

  // ---- glyphs, motion, forced colours, focus (todo 1) ----

  await check("status-glyphs", async () => {
    const { page } = await open({ fleet: "FREADY" });
    const dots = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".status-dot")].map((dot) => {
      const style = getComputedStyle(dot);
      return { state: dot.dataset["state"], size: dot.dataset["size"] ?? "default", width: dot.getBoundingClientRect().width, shadow: style.boxShadow, filter: style.filter, animation: style.animationName };
    }));
    const wrong = dots.filter((dot) => dot.shadow !== "none" || dot.filter !== "none" || (dot.state !== "checking" && dot.state !== "updating" && dot.animation !== "none")
      || (dot.size === "default" && Math.round(dot.width) !== 14));
    expect(dots.length > 0 && wrong.length === 0, `glyphs off the rule (14px, no shadow, still at rest): ${JSON.stringify(wrong.slice(0, 4))}`);
    return `${dots.length} glyphs: 14px, no shadow or filter, none animated at rest`;
  });

  await check("reduced-motion", async () => {
    const { page } = await open({ fleet: "FREADY", reducedMotion: true });
    const running = await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length);
    expect(running === 0, `${running} animations run under reduced motion`);
    return "0 running";
  });

  await check("forced-colors", async () => {
    const { page } = await open({ fleet: "FREADY", forcedColors: true });
    const faint = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".status-dot")].filter((dot) => {
      const color = getComputedStyle(dot).color;
      return dot.getBoundingClientRect().width === 0 || color === "rgba(0, 0, 0, 0)" || color === "transparent";
    }).length);
    expect(faint === 0, `${faint} glyphs vanish in forced colours`);
    await shot(page, "forced-colors-1440-dark", true);
    return "every glyph keeps its system colour";
  });

  await check("focus-tab", async () => {
    const { page } = await open({ fleet: "FREADY" });
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
    const ringless: string[] = [];
    for (let stop = 0; stop < 12; stop += 1) {
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body) return null;
        const style = getComputedStyle(active);
        const box = active.getBoundingClientRect();
        const visible = (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
        const inView = box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth;
        return { name: (active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 30), visible, inView };
      });
      if (ring && !(ring.visible && ring.inView)) ringless.push(JSON.stringify(ring));
    }
    expect(ringless.length === 0, `Tab stops without a visible, unclipped ring: ${ringless.join(", ")}`);
    return "12 Tab stops, each with a visible ring in view";
  });

  // ---- the Add a PC sheet (todo 5) ----

  for (const width of [1440, 390] as const) {
    await check(`sheet-add-${width}`, async () => {
      const { page } = await open({ fleet: "FREADY", width });
      await page.locator('[data-action="add-pc"]').filter({ visible: true }).first().click();
      const sheet = page.locator('[role=dialog][data-add-pc-mode="add"]');
      await sheet.waitFor();
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.effect?.getTiming().iterations === Infinity || animation.playState === "finished"));
      const box = await sheet.evaluate((element) => { const rect = element.getBoundingClientRect(); return { width: rect.width, bottom: rect.bottom, inner: window.innerHeight }; });
      const primaries = await sheet.locator(".btn-primary").count();
      expect(width === 1440 ? Math.round(box.width) === 520 : box.width <= 390, `sheet ${box.width}px wide (520 on a desktop)`);
      expect(box.bottom <= box.inner + 0.5, `the sheet's foot is inside the viewport (${box.bottom} <= ${box.inner})`);
      expect(primaries === 1, `${primaries} primaries in the sheet, want 1`);
      await shot(page, `sheet-add-${width}-dark`);
      return `${Math.round(box.width)}px, one primary, foot in view`;
    });
  }

  await check("keyboard-sheet", async () => {
    const { page } = await open({ fleet: "FREADY" });
    const add = page.locator('.relay-dash-top [data-action="add-pc"]');
    await add.focus();
    await page.keyboard.press("Enter");
    await page.locator("[role=dialog]").waitFor();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null), "Tab stays in the sheet");
    await page.keyboard.press("Escape");
    await page.locator("[role=dialog]").waitFor({ state: "detached" });
    const back = await page.waitForFunction(() => document.activeElement?.matches('.relay-dash-top [data-action="add-pc"]') === true, null, { timeout: 5_000 }).then(() => true, () => false);
    const at = await page.evaluate(() => { const active = document.activeElement; return active ? `${active.tagName.toLowerCase()}.${active.className}` : "none"; });
    expect(back, `focus returns to Add a PC (it is on ${at})`);
    return "Enter opens, Tab stays inside, Escape closes, focus back on Add a PC";
  });

  // ---- what the page computes for its headings, details and dialogs (final review F2 findings 2, 4 and 6) ----

  /** What holds the focus: its tag, classes and first words, the ring it shows, the PC row it sits in, and whether it is on screen. */
  const focused = (page: Page) => page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return null;
    const style = getComputedStyle(active);
    const box = active.getBoundingClientRect();
    return {
      tag: active.tagName.toLowerCase(), className: String(active.className), text: (active.textContent ?? "").trim().slice(0, 40),
      outline: style.outlineStyle, row: active.closest("[data-pc-id]")?.getAttribute("data-pc-id") ?? null,
      inView: box.top >= 0 && box.bottom <= window.innerHeight,
    };
  });

  // the view heading takes the focus after a keyboard route change and shows no ring (RelayDashboard.css .relay-dash-title:focus)
  await check("view-heading-focus", async () => {
    const { page } = await open({ fleet: "FREADY" });
    await page.locator('.relay-dash-nav a[href="#devices"]').focus();
    await page.keyboard.press("Enter");
    await page.locator('.relay-dash[data-dashboard-view="devices"]').waitFor();
    const focus = await focused(page);
    expect(focus?.tag === "h1" && focus.text === "Devices", `the view heading holds the focus after Enter on a destination (${JSON.stringify(focus)})`);
    expect(focus?.outline === "none", `the heading shows no ring (outline-style ${focus?.outline})`);
    return `h1 "Devices" focused, outline-style none`;
  });

  // below 1100px the details are a full view under the list: selecting a row moves the focus to its heading, ringless and
  // on screen, and Back gives the focus to the row that opened it; from 1100px the side panel keeps the click's focus
  await check("details-390-focus", async () => {
    const { page } = await open({ fleet: "FREADY", width: 390 });
    await go(page, "#pcs", "pcs");
    await page.evaluate(() => window.scrollTo(0, 0));
    const row = listedRows(page).filter({ hasText: "Home server" });
    const id = await row.getAttribute("data-pc-id");
    await row.locator(".relay-pc-name-btn").click();
    await page.locator("[data-pc-details]").waitFor();
    const placed = await page.evaluate(() => {
      const box = document.querySelector("[data-pc-details]")!.getBoundingClientRect();
      return { top: Math.round(box.top), inner: window.innerHeight, scrollY: Math.round(window.scrollY) };
    });
    const focus = await focused(page);
    await shot(page, "details-390-dark");
    expect(focus?.tag === "h2" && focus.text === "Home server", `the details heading holds the focus (${JSON.stringify(focus)})`);
    expect(focus?.outline === "none", `the heading shows no ring (outline-style ${focus?.outline})`);
    expect(placed.top >= 0 && placed.top < placed.inner / 2, `the details start in the upper half of the screen (top ${placed.top} of ${placed.inner}, scrolled ${placed.scrollY})`);
    await page.locator("[data-pc-details]").getByRole("button", { name: "Back" }).click();
    await page.locator("[data-pc-details]").waitFor({ state: "detached" });
    const back = await focused(page);
    await shot(page, "details-390-back-dark");
    expect(back?.row === id && back.className.includes("relay-pc-name-btn"), `Back gives the focus to the row that opened the details (${JSON.stringify(back)})`);
    return `heading focused without a ring, details top ${placed.top}px after scrolling ${placed.scrollY}px, Back focuses the row`;
  });

  await check("details-1440-side-panel", async () => {
    const { page } = await open({ fleet: "FREADY" });
    await go(page, "#pcs", "pcs");
    const before = await page.evaluate(() => window.scrollY);
    await listedRows(page).filter({ hasText: "Home server" }).locator(".relay-pc-name-btn").click();
    await page.locator("[data-pc-details]").waitFor();
    const focus = await focused(page);
    const columns = await page.locator(".relay-dash-pcs-split").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    const scrollY = await page.evaluate(() => window.scrollY);
    await shot(page, "details-1440-side-dark");
    expect(columns === 2, `the details sit beside the table (${columns} grid columns)`);
    expect(focus?.className.includes("relay-pc-name-btn") === true, `the click's focus stays on the row (${JSON.stringify(focus)})`);
    expect(scrollY === before, `the page does not scroll (${before} -> ${scrollY})`);
    return `two columns, focus on the row, no scroll`;
  });

  // the QR and code dialog is named by the heading of its current screen
  for (const width of [1440, 390] as const) {
    await check(`pair-dialog-name-${width}`, async () => {
      const { page } = await open({ fleet: "FREADY", width });
      await page.locator('[data-action="add-pc"]').filter({ visible: true }).first().click();
      await page.locator('[role=dialog][data-add-pc-mode="add"] [data-sheet-primary]').click();
      const dialog = page.locator("[role=dialog][data-pair-dialog]");
      await dialog.waitFor();
      const named = () => dialog.evaluate((element) => {
        const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").filter((text) => text !== "").join(" ") ?? null;
        return { screen: element.getAttribute("data-pair-dialog"), name: element.getAttribute("aria-label") ?? (labelled === "" ? null : labelled), heading: element.querySelector("h2")?.textContent?.trim() ?? null };
      });
      const qr = await named();
      const qrTree = (await dialog.ariaSnapshot()).split("\n")[0] ?? "";
      await shot(page, `pair-dialog-qr-${width}-dark`);
      await dialog.getByRole("button", { name: "Pair with a code" }).click();
      await page.locator('[role=dialog][data-pair-dialog="code"]').waitFor();
      const code = await named();
      const codeTree = (await dialog.ariaSnapshot()).split("\n")[0] ?? "";
      await shot(page, `pair-dialog-code-${width}-dark`);
      expect(qr.name !== null && qr.name === qr.heading, `the QR screen names its dialog by its heading (${JSON.stringify(qr)}, tree ${qrTree})`);
      expect(code.name !== null && code.name === code.heading, `the code screen names its dialog by its heading (${JSON.stringify(code)}, tree ${codeTree})`);
      return `${qrTree}; ${codeTree}`;
    });
  }

  // the sidebar foot's provider mark flows inline: AccountPcs.css positions a mark absolutely only inside .account-provider
  await check("provider-mark-inline", async () => {
    const { page } = await open({ fleet: "FREADY" });
    const placed = await page.locator(".relay-dash-foot .relay-dash-who .account-provider-mark").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const text = element.nextElementSibling?.getBoundingClientRect() ?? null;
      const row = element.parentElement!.getBoundingClientRect();
      return { position: getComputedStyle(element).position, right: Math.round(box.right), textLeft: text === null ? null : Math.round(text.left), top: Math.round(box.top), bottom: Math.round(box.bottom), rowTop: Math.round(row.top), rowBottom: Math.round(row.bottom) };
    });
    expect(placed.position === "static", `the mark is in the flow (position ${placed.position})`);
    expect(placed.textLeft !== null && placed.right <= placed.textLeft, `the mark ends before its text starts (${placed.right} <= ${placed.textLeft})`);
    expect(placed.top >= placed.rowTop && placed.bottom <= placed.rowBottom, `the mark stays inside its row (${placed.top}-${placed.bottom} in ${placed.rowTop}-${placed.rowBottom})`);
    return `static, ends at ${placed.right}px before the text at ${placed.textLeft}px`;
  });

  // the phone map's rail: each route's link reaches up through the gap to the item above, and the last one ends inside its relay's mark
  await check("map-rail-390", async () => {
    const { page } = await open({ fleet: "FREADY", width: 390 });
    await go(page, "#relay", "relay");
    await page.locator(".relay-map-routes .relay-map-route").first().waitFor();
    const rail = await page.evaluate(() => {
      const items = [...document.querySelectorAll<HTMLElement>(".relay-map-routes > li")];
      return items.map((item) => {
        const box = item.getBoundingClientRect();
        const link = item.querySelector<HTMLElement>(":scope > .relay-map-link")?.getBoundingClientRect() ?? null;
        const mark = item.querySelector<HTMLElement>(".relay-map-hop-hub-mark")?.getBoundingClientRect() ?? null;
        return { route: item.classList.contains("relay-map-route"), top: box.top, bottom: box.bottom, link: link && { top: link.top, bottom: link.bottom }, mark: mark && { top: mark.top, bottom: mark.bottom } };
      });
    });
    const routes = rail.filter((item) => item.route);
    expect(routes.length >= 2, `${routes.length} relay routes, want 2 or more`);
    const gaps: string[] = [];
    rail.forEach((item, index) => {
      if (!item.route) return;
      const above = rail[index - 1];
      if (item.link === null || above === undefined) { gaps.push(`route ${index} has no link`); return; }
      if (item.link.top > above.bottom + 0.5) gaps.push(`route ${index}: link starts ${Math.round(item.link.top - above.bottom)}px below the item above`);
      if (index < rail.length - 1) {
        if (Math.abs(item.link.bottom - item.bottom) > 0.5) gaps.push(`route ${index}: link ends at ${Math.round(item.link.bottom)}, the route at ${Math.round(item.bottom)}`);
      } else if (item.mark === null || item.link.bottom < item.mark.top - 0.5 || item.link.bottom > item.mark.bottom + 0.5) {
        gaps.push(`last route: link ends at ${Math.round(item.link.bottom)}, its relay's mark spans ${item.mark === null ? "nothing" : `${Math.round(item.mark.top)}-${Math.round(item.mark.bottom)}`}`);
      }
    });
    await shot(page, "map-rail-390-dark");
    expect(gaps.length === 0, `the rail is continuous: ${gaps.join("; ")}`);
    return `${routes.length} routes, each link meets the item above, the last ends inside its relay's mark`;
  });

  // ---- what every page above heard: no page error, no request off the two hosts, no policy violation ----

  await check("console-and-policy", async () => {
    assertCspClean(csp, "relay dashboard");
    return `${csp.length} pages under the shell's policy, no violation`;
  });

  if (evidence) writeFileSync(join(evidence, "relay-dashboard-qa.txt"), `${report.join("\n")}\n`);
  if (failed.length > 0) throw new Error(`relay dashboard QA: ${failed.length} failed: ${failed.join(", ")}`);
  return report;
}

if (import.meta.main) {
  const repo = join(import.meta.dir, "..");
  const shellDir = mkdtempSync(join(tmpdir(), "ovis-relay-dashboard-qa-site-"));
  const built = Bun.spawnSync([process.execPath, "--bun", join(repo, "node_modules/.bin/vite"), "build", "--mode", "shell", "--outDir", shellDir, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo, stdout: "inherit", stderr: "inherit" });
  if (built.exitCode !== 0) throw new Error(`the shell build failed with exit code ${built.exitCode}`);
  const site = servePagesSite(shellDir, 0, "127.0.0.1");
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await relayDashboardQa({ browser, origin: `http://127.0.0.1:${site.port}`, evidence: process.env["UI_EVIDENCE_DIR"] || null });
  } finally {
    await browser.close();
    await site.stop(true);
    rmSync(shellDir, { recursive: true, force: true });
  }
}
