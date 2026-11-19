import { describe, expect, it } from "bun:test";
import { exportAccountKey, registerSigningBytes } from "../../../shared/account-records.ts";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { AccountService, AccountServiceError } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

const SERVICE = "https://account.example";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The account service's S2-19 routes, in front of the fake: a challenge per sign-in, one key per sign-in, a key once per account. */
function withDeviceRoutes(fake: FakeAccountService, options: { opensAll: boolean }) {
  const challenges = new Map<string, string>();
  const registered: { key: string; signature: string; challenge_id: string; challenge: string }[] = [];
  const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.pathname.startsWith("/v1/devices")) return fake.fetch(input, init);
    if (!options.opensAll) return Response.json({ error: "not_found", message: "Unknown request" }, { status: 404 });
    if (url.pathname === "/v1/devices/challenge") {
      const id = crypto.randomUUID().replaceAll("-", "");
      challenges.set(id, `challenge-${id}`);
      return Response.json({ challenge_id: id, challenge: `challenge-${id}`, expires_in: 60 });
    }
    const body = JSON.parse(String(init?.body)) as { challenge_id: string; key: string; signature: string };
    const challenge = challenges.get(body.challenge_id) ?? "";
    challenges.delete(body.challenge_id);
    if (registered.length > 0 && registered[0]!.key !== body.key) return Response.json({ error: "session_has_key", message: "no" }, { status: 409 });
    registered.push({ ...body, challenge });
    return Response.json({ no: 3, key: body.key });
  };
  return { fetch, registered };
}

async function signedIn(fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>, fake: FakeAccountService) {
  fake.signInAs("github", "acct_1");
  const store = memoryAccountStore();
  const start = await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  await finishSignIn(returned!, { store, fetch });
  return new AccountService({ store, fetch, lock: memoryLock() });
}

async function deviceKey() {
  const pair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  return { private_key: pair.privateKey, public_key: pair.publicKey, public_spki: await exportAccountKey(pair.publicKey) };
}

describe("registering this sign-in's device key", () => {
  it("T34: proves the key by signing this sign-in's challenge and gets its place in the account's order", async () => {
    const fake = new FakeAccountService();
    const routes = withDeviceRoutes(fake, { opensAll: true });
    const service = await signedIn(routes.fetch, fake);
    const key = await deviceKey();
    expect(await service.registerDeviceKey(key)).toEqual({ no: 3, key: key.public_spki });
    const [sent] = routes.registered;
    const bytes = registerSigningBytes("acct_1", key.public_spki, sent!.challenge_id, sent!.challenge);
    const signature = Uint8Array.from(atob(sent!.signature.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key.public_key, signature, bytes)).toBe(true);
  });

  it("G5: a service with the release off answers nothing to register, and the QR or digits path stays", async () => {
    const fake = new FakeAccountService();
    const service = await signedIn(withDeviceRoutes(fake, { opensAll: false }).fetch, fake);
    expect(await service.registerDeviceKey(await deviceKey())).toBeNull();
  });

  it("T40: a sign-in that registered a key cannot move to another one", async () => {
    const fake = new FakeAccountService();
    const service = await signedIn(withDeviceRoutes(fake, { opensAll: true }).fetch, fake);
    await service.registerDeviceKey(await deviceKey());
    await expect(service.registerDeviceKey(await deviceKey())).rejects.toBeInstanceOf(AccountServiceError);
  });
});

