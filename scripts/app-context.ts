import assert from "node:assert/strict";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright-core";

/**
 * What every browser script's context starts from, so two scripts differ only where one says so:
 * - no service worker. The app's worker answers every /assets/ file of a page it controls, and on a loaded runner a
 *   page whose module preload it was answering stayed on the boot screen (#4777). A script about the worker allows it.
 * - English. Headless Chromium takes its language from the machine (LANGUAGE), and the scripts assert the English copy.
 *
 * No time zone is set: a script that formats a time on its own side compares it with the page's, and both follow the
 * machine. A script that needs one names it (`timezoneId`), as it names any other option.
 */
export const APP_CONTEXT = { serviceWorkers: "block", locale: "en-US" } as const satisfies BrowserContextOptions;

/** A context that starts from APP_CONTEXT. `overrides` are the script's own choices and win, key by key. */
export function appContext(browser: Browser, overrides: BrowserContextOptions = {}): Promise<BrowserContext> {
  return browser.newContext({ ...APP_CONTEXT, ...overrides });
}

/**
 * Starts Playwright's clock on a page that has loaded nothing yet. A clock that starts or moves under a loaded app
 * page lets that page's timers take the new time before the next navigation unloads it (#4795), so it is refused there.
 */
export async function installClock(page: Page, options?: Parameters<Page["clock"]["install"]>[0]): Promise<void> {
  assert.equal(page.url(), "about:blank", "installClock: start the clock before the page's first navigation, not under a loaded page");
  await page.clock.install(options);
}
