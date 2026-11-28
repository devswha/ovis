import { chromium, type BrowserContext, type BrowserContextOptions } from "playwright-core";
import { appContext } from "./app-context.ts";
import { chromePath } from "./chrome-path.ts";

export interface LiveBrowserSession {
  readonly newContext: (overrides?: BrowserContextOptions) => Promise<BrowserContext>;
}

/**
 * Launches headless Chromium against an already-running local or Tailscale preview URL via `appContext`
 * (`scripts/app-context.ts`), kept separate from `withDemoBrowser` so demo-launch ratchets stay exact.
 */
export async function withLiveBrowser<T>(
  run: (session: LiveBrowserSession) => Promise<T>,
  args: string[] = ["--no-sandbox"],
): Promise<T> {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args });
  try {
    return await run({ newContext: (overrides) => appContext(browser, overrides) });
  } finally {
    await browser.close();
  }
}
