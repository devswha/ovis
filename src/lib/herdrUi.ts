/**
 * herdr's `[ui] copy_on_select` on the PC serving this page (GET /api/herdr-ui), which a drag in the
 * terminal follows as herdr's own TUI does (#1559), for local and remote panes alike. Until a read
 * answers, letting go of a drag copies nothing: copying that was turned off must not happen once.
 * Only an older server, which has no such route (404 not_found), stands for herdr's default (on).
 */
import { HERDR_PREFIX_ACTIONS, type HerdrKeys } from "../../shared/herdr-keys.ts";
import { apiFetch } from "./api-request-id.ts";

let known: boolean | null = null;
let keys: HerdrKeys | null = null;
let loading: Promise<void> | null = null;

export function copyOnSelect(): boolean {
  return known === true;
}

export function herdrUiKnown(): boolean {
  return known !== null;
}

export function herdrKeys(): HerdrKeys | null {
  return keys;
}

function readKeys(value: unknown): HerdrKeys | null {
  if (typeof value !== "object" || value === null) return null;
  const { prefix, prefixes, bindings } = value as { prefix?: unknown; prefixes?: unknown; bindings?: unknown };
  if (typeof prefix !== "string" || typeof bindings !== "object" || bindings === null) return null;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((key) => typeof key === "string");
  const read = bindings as Record<string, unknown>;
  if (!HERDR_PREFIX_ACTIONS.every((action) => strings(read[action]))) return null;
  return {
    prefix,
    prefixes: strings(prefixes) && prefixes.length > 0 ? prefixes : [prefix],
    bindings: Object.fromEntries(HERDR_PREFIX_ACTIONS.map((action) => [action, read[action]])) as HerdrKeys["bindings"],
  };
}

export function loadHerdrUi(read: (url: string, init?: RequestInit) => Promise<Response> = apiFetch): Promise<void> {
  if (loading !== null) return loading;
  let request: Promise<Response>;
  try { request = read("/api/herdr-ui", { cache: "no-store" }); } catch (error) { request = Promise.reject(error); }
  loading = (async () => {
    try {
      const response = await request;
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const value = typeof body === "object" && body !== null ? (body as { copy_on_select?: unknown }).copy_on_select : undefined;
        if (typeof value === "boolean") known = value;
        keys = readKeys((body as { keys?: unknown } | null)?.keys);
      } else if (response.status === 404 && (body as { error?: { code?: unknown } } | null)?.error?.code === "not_found") {
        known = true;
      }
    } catch {}
    finally { loading = null; }
  })();
  return loading;
}

export function forgetHerdrUi(): void {
  known = null;
  keys = null;
  loading = null;
}
