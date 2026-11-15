/**
 * Runs inside a world's service container (WORLD_ROLE): the relay, or the account service with its control API.
 * The checkout under test is at WORLD_REPO (read-only); its modules are loaded from there, so `--repo` decides
 * whose relay and fake run. Control API (inside the sealed network only):
 *   GET  /ready                 {relay_pass_keys, kind, ...}: what the relay needs, once the service is up
 *   POST /call {method, args}   any method of the fake (FakeAccountService), so a new one needs no change here
 *   POST /token {account}       an access token for that account (fake: issueToken; real: POST /v1/test/token)
 *   GET  /requests?from=N       the account service's request log
 * With WORLD_CONTROL_SECRET set (M2's long-lived services), every route but /ready answers only a request whose
 * X-World-Control header carries that secret (compared in constant time), and /ready says only the kind and the relay's
 * pass keys (public keys). A world's own control API has no secret: it lives as long as its test.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { linkPage, parsePeople, personFront, withCors } from "./linkpage.ts";
const REPO = process.env["WORLD_REPO"] ?? "/opt/ovis";
const BIND = process.env["WORLD_BIND"] ?? "";
const ROLE = process.env["WORLD_ROLE"];
const KID = "7e57a001";
if (BIND === "") throw new Error("WORLD_BIND (this container's address) is required");

const log = (event: string, detail: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
const json = (value: unknown, status = 200) => Response.json(value ?? null, { status });
const stoppers: (() => unknown)[] = [];
const SECRET = process.env["WORLD_CONTROL_SECRET"] ?? "";
const digest = (text: string) => createHash("sha256").update(text).digest();
/** Whether a control request may pass: no secret configured, the minimal /ready, or the secret in X-World-Control. */
const allowed = (request: Request, path: string) => SECRET === "" || path === "/ready" || timingSafeEqual(digest(request.headers.get("x-world-control") ?? ""), digest(SECRET));
const refused = () => json({ error: "the control API needs its secret (X-World-Control)" }, 401);

async function relay(): Promise<void> {
  const { startBunRelay }: typeof import("../../../relay/bun.ts") = await import(`${REPO}/relay/bun.ts`);
  const { passPolicy }: typeof import("../../../relay/pass.ts") = await import(`${REPO}/relay/pass.ts`);
  const limits = JSON.parse(process.env["WORLD_LIMITS"] ?? "{}") as Record<string, number>;
  const mode = process.env["WORLD_PASSES"] ?? "off";
  const keys = process.env["WORLD_PASS_KEYS"] ?? "";
  const pass = await passPolicy(mode === "off" ? {} : { RELAY_PASS_MODE: mode, RELAY_PASS_KEYS: keys });
  const started = startBunRelay({ port: 8787, hostname: BIND, limits, pass });
  stoppers.push(() => started.stop());
  log("ready", { role: "relay", port: started.port, limits, passes: mode });
}

async function fakeAccount(): Promise<void> {
  const { FakeAccountService }: typeof import("../../../shared/account-service-fake.ts") = await import(`${REPO}/shared/account-service-fake.ts`);
  const { signRelayPass }: typeof import("../../../shared/relay-pass.ts") = await import(`${REPO}/shared/relay-pass.ts`);
  const { verifyServerProof }: typeof import("../../../shared/relay-server-proof.ts") = await import(`${REPO}/shared/relay-server-proof.ts`);
  const service = new FakeAccountService();
  service.offerLinkPage(["github", "google"]);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicHex = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("hex");
  const lifetime = Number(process.env["WORLD_PASS_LIFETIME_S"] ?? 48 * 3600);
  // the fake keeps its challenges to itself; the world's pass route reads the one a PC answers
  const challenges = (service as unknown as { challenges: Map<string, { server_id: string; expected: string; expires: number }> }).challenges;

  const relayPass = async (request: Request): Promise<Response> => {
    const body = await request.json() as Record<string, unknown>;
    const challenge = typeof body["challenge_id"] === "string" ? challenges.get(body["challenge_id"]) : undefined;
    if (typeof body["challenge_id"] === "string") challenges.delete(body["challenge_id"]);
    if (!challenge || challenge.server_id !== body["server_id"] || Date.now() > challenge.expires || !verifyServerProof(body["proof"], challenge.expected)) return json({ error: { code: "proof_invalid" } }, 401);
    if (typeof body["account"] !== "string" || !service.pcs(body["account"]).some((pc) => pc.server_id === body["server_id"])) return json({ error: { code: "not_listed" } }, 403);
    const pass = await signRelayPass(pair.privateKey, KID, challenge.server_id, Math.floor(Date.now() / 1000), lifetime);
    return json({ pass, expires_in: lifetime, refresh_in: Math.floor(lifetime / 4) });
  };

  // B2: with a people file the fake gets the person's page at /link (inside/linkpage.ts); the file is never logged
  const peopleFile = process.env["WORLD_PEOPLE"];
  // behind a people file the fake signs a person in on /link only: its passphrase-free sign-in routes are refused
  const link = peopleFile ? personFront(linkPage(service, parsePeople(readFileSync(peopleFile, "utf8")), "github")) : null;
  const account = Bun.serve({
    hostname: BIND, port: 9080, idleTimeout: 60,
    fetch: (incoming) => withCors(incoming, async () => {
      // the fake names its pages from the origin the caller used: the TLS proxy's Host, or the origin a device asked for
      const url = new URL(incoming.url);
      const began = Date.now();
      const origin = incoming.headers.get("x-world-origin") ?? `https://${incoming.headers.get("host") ?? "account.world.test:9443"}`;
      const request = new Request(new URL(`${url.pathname}${url.search}`, origin), incoming);
      const response = (link ? await link(request) : null) ?? (url.pathname === "/v1/pc/relay-pass" && request.method === "POST" ? await relayPass(request) : await service.fetch(request));
      log("account", { method: request.method, path: url.pathname, status: response.status, ms: Date.now() - began });
      return response;
    }),
  });
  const methods = service as unknown as Record<string, unknown>;
  const control = Bun.serve({
    hostname: BIND, port: 9090,
    async fetch(request) {
      const url = new URL(request.url);
      if (!allowed(request, url.pathname)) return refused();
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
      switch (url.pathname) {
        case "/ready": return json({ kind: "fake", relay_pass_keys: `${KID}:${publicHex}`, people: link !== null });
        case "/token": return json({ token: service.issueToken(String(body["account"])) });
        case "/requests": return json(service.requests.slice(Number(url.searchParams.get("from") ?? 0)));
        case "/call": {
          const method = String(body["method"]);
          const target = methods[method];
          if (method === "fetch" || method === "constructor" || typeof target !== "function") return json({ error: `no method ${method} on the fake` }, 404);
          try {
            return json({ result: await (target as (...args: unknown[]) => unknown).apply(service, Array.isArray(body["args"]) ? body["args"] : []) });
          } catch (error) {
            return json({ error: (error as Error).message }, 409);
          }
        }
        default: return json({ error: "unknown control route" }, 404);
      }
    },
  });
  stoppers.push(() => account.stop(true), () => control.stop(true));
  log("ready", { role: "account", kind: "fake" });
}

/** the account service's `bun run local` (ovis-sh/account), started in WORLD_ACCOUNT_REPO; its one JSON ready line is kept. */
async function realAccount(): Promise<void> {
  const repo = process.env["WORLD_ACCOUNT_REPO"] ?? "/opt/account";
  const state = process.env["WORLD_ACCOUNT_STATE"] ?? `${process.env["HOME"]}/account-state`;
  const extra = [...JSON.parse(process.env["WORLD_ACCOUNT_ARGS"] ?? "[]") as string[], ...(process.env["WORLD_PEOPLE"] ? ["--people", process.env["WORLD_PEOPLE"]] : [])];
  const child = Bun.spawn(["bun", "run", "local", "--host", BIND, "--port", "9080", "--public-url", process.env["WORLD_PUBLIC_URL"] ?? "https://account.world.test:9443", "--state", state, ...extra],
    { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  stoppers.push(() => child.kill("SIGTERM"));
  let ready: Record<string, unknown> | null = null;
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (ready === null && line.startsWith("{")) {
          try { ready = JSON.parse(line) as Record<string, unknown>; log("ready", { role: "account", kind: "real", base: ready["base"] }); continue; } catch { /* not the ready line */ }
        }
        console.log(line);
      }
    }
  })();
  void child.exited.then((code) => { log("account-exited", { code }); process.exit(code === 0 ? 1 : code); });
  // the ready line's relay_pass_keys: {kid: hex} in the real code (scripts/local.ts), a list or a string elsewhere
  const keys = (value: unknown) => Array.isArray(value) ? value.join(",")
    : typeof value === "object" && value !== null ? Object.entries(value).map(([kid, hex]) => `${kid}:${String(hex)}`).join(",") : String(value ?? "");
  const control = Bun.serve({
    hostname: BIND, port: 9090,
    async fetch(request) {
      const url = new URL(request.url);
      if (!allowed(request, url.pathname)) return refused();
      const current = ready;
      if (current === null) return json({ error: "not ready" }, 503);
      switch (url.pathname) {
        // the sign-in key is never handed out: callers ask for a token
        case "/ready": return json(SECRET !== "" ? { kind: "real", relay_pass_keys: keys(current["relay_pass_keys"]) }
          : { kind: "real", base: current["base"], public_url: current["public_url"], relay_pass_keys: keys(current["relay_pass_keys"]), state: current["state"] });
        case "/token": {
          const body = await request.json() as Record<string, unknown>;
          const answer = await fetch(`${String(current["base"])}/v1/test/token`, { method: "POST", headers: { "content-type": "application/json", "x-test-signin-key": String(current["test_signin_key"]) }, body: JSON.stringify({ subject: body["account"] }) });
          const minted = await answer.json() as Record<string, unknown>;
          if (!answer.ok) return json({ error: `POST /v1/test/token: ${answer.status} ${JSON.stringify(minted).slice(0, 200)}` }, 502);
          return json({ token: minted["token"] ?? minted["access_token"], answer: minted });
        }
        default: return json({ error: `${url.pathname} is offered by the fake only` }, 404);
      }
    },
  });
  stoppers.push(() => control.stop(true));
}

switch (ROLE) {
  case "relay": await relay(); break;
  case "account": await fakeAccount(); break;
  case "account-real": await realAccount(); break;
  default: throw new Error("WORLD_ROLE is relay, account or account-real");
}

const stop = () => { void Promise.all(stoppers.map((stopper) => stopper())).then(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
