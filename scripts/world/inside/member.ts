/**
 * A scripted member device with no browser, run inside a world's container (Machine.memberDevice): it signs in to the
 * test account, pairs with a machine through the world's relay from the link `ovis add` showed, and calls that
 * machine's /api/account/link and /api/account/enroll, all with the repository's own client code (WORLD_REPO, the
 * checkout under test): the app's device sign-in, relay transport, device store contract and account join steps.
 * Nothing of the protocol is written here; only the person's part of the sign-in is scripted, on the world's /link
 * page (inside/linkpage.ts), with the passphrase read from stdin so it is in no argument.
 *   bun member.ts member   the whole join; prints one JSON line per step, the last one {"done": ...}
 *   bun member.ts skip     a device that skips the pairing: it signs in with a pairing it made up
 * stdin: the passphrase on its first line, the pairing link on its second (a bearer capability: on no command line).
 */
import type { RelayDevice } from "../../../shared/relay-device.ts";
import type { RelayDeviceStore } from "../../../src/lib/relay/device.ts";

const REPO = process.env["WORLD_REPO"] ?? "/opt/ovis";
const SERVICE = process.env["WORLD_ACCOUNT_URL"] ?? "";
const LABEL = "world member device";
const [mode = ""] = process.argv.slice(2);

const { decodeOffer }: typeof import("../../../shared/relay-offer.ts") = await import(`${REPO}/shared/relay-offer.ts`);
const { openRelayTransport }: typeof import("../../../src/lib/relay/transport.ts") = await import(`${REPO}/src/lib/relay/transport.ts`);
const { offerOf }: typeof import("../../../src/lib/relay/shellState.ts") = await import(`${REPO}/src/lib/relay/shellState.ts`);
const { memoryAccountStore, memoryLock }: typeof import("../../../src/lib/account/store.ts") = await import(`${REPO}/src/lib/account/store.ts`);
const { startDeviceSignIn }: typeof import("../../../src/lib/account/deviceSignIn.ts") = await import(`${REPO}/src/lib/account/deviceSignIn.ts`);
const join: typeof import("../../../src/lib/account/join.ts") = await import(`${REPO}/src/lib/account/join.ts`);

const say = (step: string, detail: Record<string, unknown> = {}) => console.log(JSON.stringify({ step, ...detail }));
const failed = (error: unknown) => ({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), ...(error instanceof join.AccountPcError ? { status: error.status, code: error.code } : {}) });

/** The device's saved pairings, kept in memory: the store contract the app keeps in IndexedDB (src/lib/relay/device.ts). */
function memoryDevices(): RelayDeviceStore {
  const devices = new Map<string, RelayDevice>();
  return {
    get: async (serverId) => devices.get(serverId),
    list: async () => [...devices.values()],
    remove: async (serverId) => { devices.delete(serverId); },
    update: async (serverId, change, source) => {
      source?.assert(devices.get(source.serverId));
      const next = change(devices.get(serverId));
      devices.set(serverId, next);
      return next;
    },
  };
}

/** The person's part, on the world's /link page: the code the device showed, the passphrase, then the confirm. */
async function approveAsPerson(code: string, passphrase: string): Promise<void> {
  const form = (fields: Record<string, string>) => ({ method: "POST", body: new URLSearchParams(fields), redirect: "manual" as const });
  const asked = await fetch(new URL("/link", SERVICE), form({ code, passphrase }));
  const page = await asked.text();
  const token = /name="token" value="([0-9a-f]+)"/.exec(page)?.[1];
  if (!asked.ok || token === undefined) throw new Error(`the /link page did not ask to confirm (${asked.status})`);
  const confirmed = await fetch(new URL("/link/confirm", SERVICE), form({ token, decision: "approve" }));
  if (!confirmed.ok) throw new Error(`the /link confirm answered ${confirmed.status}`);
}

async function main(): Promise<number> {
  if (SERVICE === "" || (mode !== "member" && mode !== "skip")) { console.error("usage: bun member.ts member|skip (stdin: passphrase, then the pairing link; WORLD_ACCOUNT_URL set)"); return 2; }
  const [passphrase = "", link = ""] = (await new Response(Bun.stdin.stream()).text()).split("\n").map((line) => line.trim());
  const offer = decodeOffer(link);
  if (offer === null) throw new Error("not a pairing link (no #offer=)");
  const accountStore = memoryAccountStore();
  const store = memoryDevices();

  // the sign-in: the app's own device flow on the account service's link page
  const signIn = await startDeviceSignIn({ service: SERVICE, store: accountStore, provider: "ovis", lock: memoryLock(), requester: { label: LABEL, os: null } });
  await approveAsPerson(signIn.userCode, passphrase);
  const session = await signIn.finish(AbortSignal.timeout(60_000));
  const key = await accountStore.key();
  say("signed-in", { account: session.account, provider: session.provider });

  if (mode === "skip") {
    // no pairing: a saved pairing it made up for this PC, a row id of the form the PC gives (16 hex) that it never gave, and the account key
    await store.update(offer.server_id, () => ({ server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay, device_id: Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex"), private_key: key.private_key, public_spki: key.public_spki, label: LABEL }));
    try {
      const opened = await openRelayTransport(offerOf((await store.get(offer.server_id))!), { store, label: LABEL });
      const linked = await join.post(opened.fetch.bind(opened), "/api/account/link", {}).then((answer) => answer.status, failed);
      say("done", { refused: false, link: linked });
      opened.close();
      return 1;
    } catch (error) {
      say("done", { refused: true, ...failed(error) });
      return 0;
    }
  }

  // the pairing: the QR's offer with its code, under the account key (accountController's prepare)
  const paired = await openRelayTransport(offer, { store, label: LABEL, accountKey: key, intent: "pc" });
  let device = (await store.get(offer.server_id))!;
  say("paired", { server_id: offer.server_id, device_id: device.device_id, account_key: device.public_spki === key.public_spki });
  paired.close();
  // a session that just paired has not proved its key: the account's steps take a session of their own (accountController's enroll)
  const own = await openRelayTransport(offerOf(device), { store, label: LABEL });
  const status = await join.pcAccountStatus(own.fetch.bind(own));
  const linking = join.needsLink(status, device, session.account);
  say("status-before", { account: status.account, enrolling: status.enrolling ?? null, linking });
  if (linking && (status.account === null || status.enrolling === true)) await join.planEnroll(accountStore, offer.server_id, session.account);
  if (linking) {
    try { device = await join.linkThisDevice({ fetch: own.fetch.bind(own), device, key, account: session.account, store }); }
    catch (error) { say("link", failed(error)); own.close(); return 1; }
    say("link", { status: 200, account: device.account ?? null });
  }
  own.close();
  // the PC takes an enrollment only from a session signed in with the account key as a member
  const signedIn = await openRelayTransport(offerOf(device), { store, label: LABEL });
  const pc = { server_id: offer.server_id, server_public_key: device.server_public_key, relay: device.relay, name: (device.name ?? offer.server_id.slice(0, 8)).slice(0, 48) };
  let enrollment: Awaited<ReturnType<typeof join.enrollOnPc>>;
  try { enrollment = await join.enrollOnPc({ fetch: signedIn.fetch.bind(signedIn), store: accountStore, account: session.account, serverId: offer.server_id, pc, listed: 0 }); }
  catch (error) { say("enroll", failed(error)); signedIn.close(); return 1; }
  say("enroll", { enrollment });
  const after = await join.pcAccountStatus(signedIn.fetch.bind(signedIn));
  signedIn.close();
  say("done", { account: after.account, enrolling: after.enrolling ?? null, unlinked: after.unlinked.length, member: after.account === session.account && after.enrolling === false });
  return after.account === session.account && after.enrolling === false ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  say("done", failed(error));
  process.exitCode = 1;
}
