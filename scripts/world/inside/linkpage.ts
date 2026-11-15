/**
 * B2: the sign-in as a person does it, in front of the repository's fake (never in shared/): the page at
 * <account origin>/link takes the code (from ?code= or typed) and a passphrase that names one test identity, shows who
 * asked, and approves or refuses on a confirm. Passphrases come from a file of `name:passphrase` lines, the form
 * the account service's `--people <file>` takes. A wrong passphrase gets nothing; wrong tries are limited for everyone
 * together (10 in ten minutes, as the real code); no passphrase is in a URL, an argument, a log or a description.
 * The code lasts ten minutes (the fake's) and the confirm five, as the real code (src/linkpage.ts:24-25).
 * Also the /v1 CORS answers of the real code (src/worker.ts:21-38): any origin, preflight 204.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface LinkService {
  linkRequester(userCode: string): { label: string | null; os: unknown } | undefined;
  approveOnLinkPage(userCode: string, account: string, provider: "github" | "google" | "apple"): void;
  denyDevice(userCode: string): void;
}

const WINDOW_MS = 10 * 60_000;
const WRONG_PER_WINDOW = 10;
const CONFIRM_MS = 5 * 60_000;
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** The file's people: `name:passphrase` per line; names are a-z 0-9 - _, passphrases at least 12 characters. */
export function parsePeople(text: string): Map<string, Buffer> {
  const people = new Map<string, Buffer>();
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const split = line.indexOf(":");
    const name = line.slice(0, split);
    const passphrase = line.slice(split + 1);
    if (split < 1 || !/^[a-z0-9_-]{1,32}$/.test(name) || passphrase.length < 12) throw new Error(`people file, line ${index + 1}: name:passphrase (a-z 0-9 - _, at least 12 characters)`);
    if (people.has(name)) throw new Error(`people file, line ${index + 1}: ${name} twice`);
    people.set(name, digest(passphrase));
  }
  if (people.size === 0) throw new Error("people file: nobody in it");
  return people;
}

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-expose-headers": "retry-after",
} as const;

/** The real code's /v1 CORS: a preflight is answered before anything else, every answer carries the headers. */
export async function withCors(request: Request, handle: () => Promise<Response>): Promise<Response> {
  if (!new URL(request.url).pathname.startsWith("/v1/")) return handle();
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const answer = await handle();
  const headers = new Headers(answer.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const page = (title: string, body: string, status = 200, extra: Record<string, string> = {}) => new Response(
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>` +
  `<body style="font:16px system-ui;max-width:28rem;margin:2rem auto;padding:0 1rem"><p><b>Ovis TEST account service</b> (not your real account)</p><h1 style="font-size:1.3rem">${escape(title)}</h1>${body}</body></html>`,
  { status, headers: { ...PAGE_HEADERS, ...extra } });

const codeForm = (code: string, note = "") => `${note ? `<p>${escape(note)}</p>` : ""}<form method="post" action="/link">
<label>Code from your device<br><input name="code" value="${escape(code)}" autocomplete="off" required style="font-size:1.2rem;width:100%"></label><br><br>
<label>Your test passphrase<br><input name="passphrase" type="password" autocomplete="off" required style="font-size:1.2rem;width:100%"></label><br><br>
<button type="submit" style="font-size:1.1rem">Continue</button></form>`;

/**
 * The fake's sign-in routes that need no passphrase: its provider redirect (GET /v1/signin/<provider>, which hands out a
 * code at once) and its provider device flows (POST /v1/signin/<provider>/device). Behind a people file the fake signs
 * a person in on /link only (POST /v1/signin/ovis/device, finished there), so these are refused.
 */
export function passphraseFree(request: Request): boolean {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && /^\/v1\/signin\/[a-z]+$/.test(pathname)) return true;
  return request.method === "POST" && /^\/v1\/signin\/[a-z]+\/device$/.test(pathname) && pathname !== "/v1/signin/ovis/device";
}

/** What the fake answers a passphrase-free sign-in behind a people file. */
export const refusedWithoutPassphrase = () => Response.json({ error: { code: "passphrase_required", message: "This test service signs a person in on its /link page only" } }, { status: 403 });

export type LinkHandler = ((request: Request) => Promise<Response | null>) & { readonly pending: () => number };

/** The fake's front with a people file: its passphrase-free sign-in routes refused, /link answered, null for the rest. */
export function personFront(link: LinkHandler): (request: Request) => Promise<Response | null> {
  return async (request) => passphraseFree(request) ? refusedWithoutPassphrase() : link(request);
}

/** The /link page's handler; null for any other path, which goes on to the fake. `pending()`: confirms still open. */
export function linkPage(service: LinkService, people: ReadonlyMap<string, Buffer>, provider: "github" | "google" | "apple", now: () => number = Date.now): LinkHandler {
  let window = { start: 0, wrong: 0 };
  const confirms = new Map<string, { code: string; name: string; expires: number }>();
  // a confirm nobody answered ends with its five minutes: dropped at the next POST, so the map stays as small as the open ones
  const sweep = () => { for (const [token, confirm] of confirms) if (now() > confirm.expires) confirms.delete(token); };
  const spent = () => { if (now() - window.start >= WINDOW_MS) window = { start: now(), wrong: 0 }; return window.wrong >= WRONG_PER_WINDOW; };
  const retryAfter = () => String(Math.ceil((window.start + WINDOW_MS - now()) / 1000));
  const person = (passphrase: string): string | null => {
    const offered = digest(passphrase);
    let found: string | null = null;
    for (const [name, kept] of people) if (timingSafeEqual(offered, kept)) found = name;
    return found;
  };
  const handle = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/link" && url.pathname !== "/link/confirm") return null;
    if (request.method === "GET" && url.pathname === "/link") return page("Sign a device in", codeForm(url.searchParams.get("code") ?? ""));
    if (request.method !== "POST") return page("Not here", "<p>Open the link your device showed.</p>", 405);
    sweep();
    const form = await request.formData();
    const field = (name: string) => String(form.get(name) ?? "").trim();
    if (url.pathname === "/link") {
      if (spent()) return page("Too many tries", "<p>Too many wrong passphrases. Wait, then try again.</p>", 429, { "retry-after": retryAfter() });
      const code = field("code").toUpperCase();
      const name = person(field("passphrase"));
      const requester = code === "" ? undefined : service.linkRequester(code);
      if (name === null || requester === undefined) {
        window.wrong += 1;
        return page("Not signed in", codeForm(code, "That code or passphrase did not work. Check both and try again."), 403);
      }
      const token = randomBytes(24).toString("hex");
      confirms.set(token, { code, name, expires: now() + CONFIRM_MS });
      const who = [requester.label, typeof requester.os === "string" ? requester.os : null].filter(Boolean).join(" · ") || "a device";
      return page("Sign this device in?", `<p>${escape(who)} asks to sign in to the test account <b>${escape(name)}</b>. Whoever is signed in can open the terminals of your machines.</p>
<form method="post" action="/link/confirm"><input type="hidden" name="token" value="${token}">
<button name="decision" value="approve" style="font-size:1.1rem">Sign it in</button> <button name="decision" value="refuse" style="font-size:1.1rem">Refuse</button></form>
<p>This question ends in five minutes.</p>`);
    }
    const token = field("token");
    const confirm = confirms.get(token);
    confirms.delete(token);
    if (!confirm || now() > confirm.expires) return page("Too late", "<p>This question has ended. Start again from your device.</p>", 410);
    if (field("decision") !== "approve") {
      service.denyDevice(confirm.code);
      return page("Refused", "<p>The device was not signed in. You can close this tab.</p>");
    }
    service.approveOnLinkPage(confirm.code, confirm.name, provider);
    return page("Signed in", "<p>Done. Go back to the tab of the app that showed the code: it signs itself in.</p>");
  };
  return Object.assign(handle, { pending: () => confirms.size });
}
