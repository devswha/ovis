import { describe, expect, it } from "bun:test";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { linkPage, parsePeople, personFront, withCors } from "./linkpage.ts";

const OWNER = "correct horse battery staple";
const people = parsePeople(`owner:${OWNER}\nstranger:another long passphrase\n`);

function world(start = 1_000_000) {
  let clock = start;
  const approved: string[] = [];
  const denied: string[] = [];
  const service = {
    linkRequester: (code: string) => code === "ABCD-EFGH" ? { label: "m1-box", os: "linux" } : undefined,
    approveOnLinkPage: (code: string, account: string) => { approved.push(`${code}:${account}`); },
    denyDevice: (code: string) => { denied.push(code); },
  };
  const handle = linkPage(service, people, "github", () => clock);
  const post = async (path: string, fields: Record<string, string>) => (await handle(new Request(`https://account.test${path}`, { method: "POST", body: new URLSearchParams(fields) })))!;
  const token = async (passphrase: string) => /name="token" value="([0-9a-f]+)"/.exec(await (await post("/link", { code: "ABCD-EFGH", passphrase })).text())?.[1];
  return { approved, denied, post, token, pending: () => handle.pending(), tick: (ms: number) => { clock += ms; } };
}

describe("the /link page of the fake", () => {
  it("signs in the identity whose passphrase is given, only after the confirm", async () => {
    const w = world();
    const token = await w.token(OWNER);
    expect(token).toBeDefined();
    expect(w.approved).toEqual([]);
    const done = await w.post("/link/confirm", { token: token!, decision: "approve" });
    expect(done.status).toBe(200);
    expect(w.approved).toEqual(["ABCD-EFGH:owner"]);
    expect((await w.post("/link/confirm", { token: token!, decision: "approve" })).status).toBe(410);
  });

  it("gives nothing for a wrong passphrase or code, and never shows the passphrase back", async () => {
    const w = world();
    const wrong = await w.post("/link", { code: "ABCD-EFGH", passphrase: "not the passphrase at all" });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).not.toContain("not the passphrase at all");
    expect((await w.post("/link", { code: "ZZZZ-ZZZZ", passphrase: OWNER })).status).toBe(403);
    expect(w.approved).toEqual([]);
  });

  it("stops everyone after 10 wrong tries in ten minutes, the right passphrase too", async () => {
    const w = world();
    for (let i = 0; i < 10; i++) await w.post("/link", { code: "ABCD-EFGH", passphrase: `guess number ${i} here` });
    const blocked = await w.post("/link", { code: "ABCD-EFGH", passphrase: OWNER });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    w.tick(10 * 60_000);
    expect(await w.token(OWNER)).toBeDefined();
  });

  it("ends the confirm after five minutes and refuses on refuse", async () => {
    const w = world();
    const late = await w.token(OWNER);
    w.tick(5 * 60_000 + 1);
    expect((await w.post("/link/confirm", { token: late!, decision: "approve" })).status).toBe(410);
    const refused = await w.token(OWNER);
    await w.post("/link/confirm", { token: refused!, decision: "refuse" });
    expect([w.approved, w.denied]).toEqual([[], ["ABCD-EFGH"]]);
  });

  it("drops a confirm nobody answered once its five minutes are over", async () => {
    const w = world();
    await w.token(OWNER);
    await w.token(OWNER);
    expect(w.pending()).toBe(2);
    w.tick(5 * 60_000 + 1);
    await w.token(OWNER);
    expect(w.pending()).toBe(1);
  });

  it("reads people files and refuses bad ones", () => {
    expect([...parsePeople("# test identities\nowner:twelve chars ok\n").keys()]).toEqual(["owner"]);
    for (const bad of ["owner:short", "Owner:twelve chars ok", "nobody", "", "a:twelve chars ok\na:twelve chars ok"]) expect(() => parsePeople(bad)).toThrow();
  });
});

describe("the /v1 CORS of the real code", () => {
  it("answers a preflight 204 before anything else and marks every /v1 answer", async () => {
    const preflight = await withCors(new Request("https://a.test/v1/pcs", { method: "OPTIONS" }), () => { throw new Error("must not run"); });
    expect([preflight.status, preflight.headers.get("access-control-allow-methods"), preflight.headers.get("access-control-allow-headers")]).toEqual([204, "GET, POST, PUT, DELETE, OPTIONS", "authorization, content-type"]);
    const answer = await withCors(new Request("https://a.test/v1/pcs"), async () => new Response("{}", { status: 401 }));
    expect([answer.status, answer.headers.get("access-control-allow-origin"), answer.headers.get("access-control-expose-headers")]).toEqual([401, "*", "retry-after"]);
    expect((await withCors(new Request("https://a.test/link"), async () => new Response("x"))).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the fake behind a people file", () => {
  const people = parsePeople("owner:owner-passphrase-1234\n");
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const redirectSignIn = () => new Request(`https://account.world.test:9443/v1/signin/github?${new URLSearchParams({ redirect_uri: "http://127.0.0.1:1/callback", response_mode: "query", state: "s", code_challenge: challenge, code_challenge_method: "S256" })}`);
  const post = (path: string, body: unknown) => new Request(`https://account.world.test:9443${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("refuses the fake's sign-in routes that need no passphrase, and lets the /link page's own sign-in through", async () => {
    const service = new FakeAccountService();
    service.offerLinkPage(["github", "google"]);
    // without the front the same request signs in at once: the route is a real way in
    const open = await service.fetch(redirectSignIn());
    expect([open.status, new URL(open.headers.get("location") ?? "http://x/").searchParams.has("code")]).toEqual([302, true]);
    const front = personFront(linkPage(service, people, "github"));
    const answer = async (request: Request) => (await front(request)) ?? service.fetch(request);
    expect((await answer(redirectSignIn())).status).toBe(403);
    for (const provider of ["github", "google", "apple"]) expect((await answer(post(`/v1/signin/${provider}/device`, {}))).status).toBe(403);
    expect((await answer(post("/v1/signin/ovis/device", { code_challenge: challenge, code_challenge_method: "S256" }))).status).toBe(200);
  });
});
