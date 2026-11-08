/**
 * relay-qa-teardown.ts in a real Chromium: a check that closes its context while the app.ovis.sh proxy is between its
 * fetch and its fulfill ends that request quietly, and a proxy that fails while the page is open still fails.
 * context.close() first disposes the context's fetched responses and only then closes its pages; the proxy's fetched
 * response is held until that disposal is done, so its fulfill always lands in that window, as it did by chance in
 * relay-dashboard-browser-qa ("Fetch response has been disposed"). Loopback only.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import type { APIResponse, BrowserContext, Route } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

const shell = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<p>shell</p>", { headers: { "content-type": "text/html" } }) });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

/** A page on app.ovis.sh proxied to `origin` as the relay QA scripts do; `outcome` is the proxy's error, or null. */
async function proxied(origin: string, fetched: (response: APIResponse) => Promise<APIResponse>): Promise<{ context: BrowserContext; outcome: Promise<unknown> }> {
  const context = await browser.newContext();
  const outcome = Promise.withResolvers<unknown>();
  const proxy = whileOpen(context, async (route: Route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await fetched(await route.fetch({ url: `${origin}${url.pathname}${url.search}` })) });
  });
  await context.route(/^https:\/\/app\.ovis\.sh\//, (route) => proxy(route).then(() => outcome.resolve(null), (error: unknown) => outcome.resolve(error)));
  const page = await context.newPage();
  void page.goto("https://app.ovis.sh/").catch(() => undefined);
  return { context, outcome: outcome.promise };
}

const failures: string[] = [];
const report = (holds: boolean, line: string): void => { console.log(`${holds ? "PASS" : "FAIL"} ${line}`); if (!holds) failures.push(line); };
try {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { context, outcome } = await proxied(`http://127.0.0.1:${shell.port}`, async (response) => { held.resolve(); await release.promise; return response; });
  const dispose = context.request.dispose.bind(context.request);
  context.request.dispose = async (options) => { await dispose(options); release.resolve(); };
  await held.promise;
  const closing = closeMarked(context);
  const error = await outcome;
  await closing;
  report(error === null, `close context mid-request: the proxy ${error === null ? "ended quietly" : `threw ${String(error).split("\n")[0]}`}`);

  const open = await proxied("http://127.0.0.1:1", async (response) => response);
  const failed = await open.outcome;
  report(failed instanceof Error, `open page: a failed proxy ${failed instanceof Error ? `still throws (${failed.message.split("\n")[0]})` : "ended quietly"}`);
  await closeMarked(open.context);
} finally {
  await browser.close();
  await shell.stop(true);
}
assert.deepEqual(failures, [], failures.join("\n"));
