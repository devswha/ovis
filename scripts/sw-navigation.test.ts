import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forgetKeptShell } from "../src/lib/shellMode.ts";
import { stampServiceWorker } from "./service-worker-build.ts";

const source = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://app.ovis.sh";
const SCOPE = `${ORIGIN}/s/${"0123456789abcdef".repeat(2)}/`;

type Store = Map<string, Response>;

/** sw.js run against in-memory caches and a network that answers `pages` and `files`. */
function worker(options: { shell: boolean; build: string; caches?: Record<string, Record<string, string>>; network: Record<string, string> }) {
  const stores = new Map<string, Store>();
  const key = (request: Request | string) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
  const page = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
  const file = (body: string) => new Response(body, { headers: { "content-type": "text/javascript" } });
  for (const [name, entries] of Object.entries(options.caches ?? {})) {
    stores.set(name, new Map(Object.entries(entries).map(([path, body]) => [key(path), path === "/" ? page(body) : file(body)])));
  }
  const open = (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, store = new Map());
    const cache = store;
    return {
      match: async (request: Request | string) => cache.get(key(request))?.clone(),
      put: async (request: Request | string, response: Response) => { cache.set(key(request), response.clone()); },
      keys: async () => [...cache.keys()].map((url) => new Request(url)),
      delete: async (request: Request | string) => cache.delete(key(request)),
    };
  };
  const cacheStorage = {
    open: async (name: string) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (request: Request | string) => {
      for (const store of stores.values()) { const hit = store.get(key(request)); if (hit) return hit.clone(); }
      return undefined;
    },
  };
  const requested: string[] = [];
  const fetch = async (request: Request | string) => {
    const url = new URL(key(request));
    requested.push(url.pathname);
    const body = options.network[url.pathname];
    if (body === undefined) return new Response("", { status: 404 });
    const response = url.pathname.startsWith("/assets/") ? file(body) : page(body);
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    location: new URL("/sw.js", ORIGIN),
    registration: { scope: SCOPE },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
  };
  const code = stampServiceWorker(source, options.build, undefined, options.shell);
  new Function("self", "caches", "fetch", code)(self, cacheStorage, fetch);

  /** Navigates to the PC's scope: what the page got, once the worker finished what it keeps. */
  async function navigate(): Promise<string> {
    let responded: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    listeners.get("fetch")!({
      request: new Request(SCOPE, { mode: "navigate" as RequestMode }),
      respondWith: (promise: Promise<Response>) => { responded = promise; },
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    });
    const body = await (await responded!).text();
    while (pending.length) await pending.shift();
    return body;
  }
  return { navigate, stores, requested, caches: cacheStorage };
}

const OLD_SHELL = '<script type="module" src="/assets/index-old.js"></script>';
const NEW_SHELL = '<script type="module" src="/assets/index-new.js"></script>';

describe("service worker navigations", () => {
  it("opens the hosted shell from the shell it kept, and keeps the network's for the next open", async () => {
    const sw = worker({
      shell: true, build: "0000000000aa",
      caches: { "ovis-v4-sheep-0000000000aa": { "/": OLD_SHELL, "/assets/index-old.js": "old" } },
      network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" },
    });
    expect(await sw.navigate()).toBe(OLD_SHELL);
    expect(await sw.navigate()).toBe(NEW_SHELL);
  });

  it("asks the network on the reload that brings in a newer shell", async () => {
    const sw = worker({
      shell: true, build: "0000000000aa",
      caches: { "ovis-v4-sheep-0000000000aa": { "/": OLD_SHELL, "/assets/index-old.js": "old" } },
      network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" },
    });
    await forgetKeptShell(sw.caches);
    expect(await sw.navigate()).toBe(NEW_SHELL);
  });

  it("still asks the network first on a PC's own server", async () => {
    const sw = worker({
      shell: false, build: "0000000000aa",
      caches: { "ovis-v4-sheep-0000000000aa": { "/": OLD_SHELL, "/assets/index-old.js": "old" } },
      network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" },
    });
    expect(await sw.navigate()).toBe(NEW_SHELL);
  });

  it("asks the network when the hosted shell kept no shell yet", async () => {
    const sw = worker({ shell: true, build: "0000000000aa", network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" } });
    expect(await sw.navigate()).toBe(NEW_SHELL);
    expect(sw.stores.get("ovis-v4-sheep-0000000000aa")?.has(`${ORIGIN}/`)).toBe(true);
  });

  it("keeps the older build's cache while a page runs the shell it holds, and retires it on the next open", async () => {
    const sw = worker({
      shell: true, build: "0000000000bb",
      caches: { "ovis-v4-sheep-0000000000aa": { "/": OLD_SHELL, "/assets/index-old.js": "old", "/assets/katex-old.js": "lazy" } },
      network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" },
    });
    expect(await sw.navigate()).toBe(OLD_SHELL);
    // the page still runs the old shell, and may ask for a chunk of its build later
    expect(sw.stores.get("ovis-v4-sheep-0000000000aa")?.has(`${ORIGIN}/assets/katex-old.js`)).toBe(true);
    expect(await sw.navigate()).toBe(NEW_SHELL);
    expect(sw.stores.has("ovis-v4-sheep-0000000000aa")).toBe(false);
  });
});
