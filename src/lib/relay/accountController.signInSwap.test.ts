import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AccountView } from "./shellState.ts";
import { memoryAccountStore, type AccountSession, type AccountStore } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";

// The front page's list of the account's PCs while another tab signs in as someone else, or out, between two reads:
// the rows of the earlier sign-in are never drawn under the one stored now, whichever read fails or hangs.
const SERVICE = "https://account.ovis.sh";
const session = (account: string): AccountSession => ({ service: SERVICE, account, provider: account === "acct-a" ? "github" : "google", access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: Date.now() + 3_600_000, sign_in_id: `sign-in-${account}` });
const rowOf = (account: string) => ({ server_id: (account === "acct-a" ? "a1" : "b2").repeat(16), label: `${account}'s PC`, added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: null, relay: null });
// a step the read waits for in the pairings list: lets a test store another sign-in inside a failed read's handling
let onList: (() => Promise<void>) | undefined;
const empty: ShellDeviceStore = {
  get: async () => undefined, list: async () => { const step = onList; onList = undefined; await step?.(); return []; }, remove: async () => {}, removeRow: async () => false,
  update: async () => { throw new Error("No pairing is made here"); },
};
type Answer = "rows" | "503" | Promise<"rows" | "503">;

describe("the account's PCs when another tab changes the sign-in between reads", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let accountStore: AccountStore;
  let answers: Record<string, Answer>;
  let asked: string[];
  let drawn: AccountView[];
  const made: { dispose(): void }[] = [];
  beforeEach(() => { browser = createShellTestPage(); accountStore = memoryAccountStore(); answers = {}; asked = []; drawn = []; onList = undefined; });
  afterEach(() => { for (const each of made.splice(0)) each.dispose(); browser.dispose(); });

  const until = async (holds: () => boolean, what: string): Promise<void> => {
    for (let turn = 0; turn < 200 && !holds(); turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    if (!holds()) throw new Error(`gave up waiting for ${what}`);
  };
  const controller = () => {
    const made_ = createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: empty, accountStore, accountService: SERVICE, accountList: null,
      accountFetch: async (input, init) => {
        const { pathname } = new URL(new Request(input).url);
        if (pathname !== "/v1/pcs") return Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
        const account = (new Headers(init?.headers).get("authorization") ?? "").replace("Bearer access-", "");
        asked.push(account);
        const answer = await answers[account];
        return answer === "rows" ? Response.json({ pcs: [rowOf(account)] }) : Response.json({ error: { code: "unavailable", message: "Down" } }, { status: 503 });
      },
      renderApp: () => ({ render() {}, unmount() {} }),
    }, { active: () => true, changed: async () => { if (made_.state !== null) drawn.push(made_.state); }, outdated: () => new Set() });
    made.push(made_);
    return made_;
  };
  const names = (view: AccountView | undefined): readonly string[] | null => view?.kind === "signed-in" ? view.pcs?.map((pc) => pc.name) ?? null : null;
  const withAsList = async () => {
    await accountStore.set("session", session("acct-a"));
    answers["acct-a"] = "rows";
    const account = controller();
    await account.refresh(true);
    expect(names(drawn.at(-1))).toEqual(["acct-a's PC"]);
    return account;
  };

  it("draws none of A's rows under B when the front page is read again after another tab signed in as B and B's read fails", async () => {
    const account = await withAsList();
    await accountStore.set("session", session("acct-b"));
    answers["acct-b"] = "503";
    await account.load(null);
    expect(drawn.at(-1)).toMatchObject({ kind: "signed-in", provider: "google" });
    expect(names(drawn.at(-1))).not.toContain("acct-a's PC");
  });

  it("draws none of A's rows under B when a read again finds B stored and B's read fails", async () => {
    const account = await withAsList();
    await accountStore.set("session", session("acct-b"));
    answers["acct-b"] = "503";
    await account.refresh(false, true);
    expect(drawn.at(-1)).toMatchObject({ kind: "signed-in", provider: "google" });
    expect(names(drawn.at(-1))).not.toContain("acct-a's PC");
  });

  it("draws none of A's rows under B when another tab signs in as B after A's read failed, while that failure is handled", async () => {
    const account = await withAsList();
    answers["acct-a"] = "503";
    answers["acct-b"] = "503";
    // the failed read's handling reads the pairings: B is stored there, after the service's own check of the sign-in
    onList = async () => { await accountStore.set("session", session("acct-b")); };
    await account.refresh(false, true);
    await until(() => asked.includes("acct-b"), "B's directory asked");
    await until(() => { const last = drawn.at(-1); return last?.kind === "signed-in" && last.provider === "google" && last.error !== null; }, "B's failed read drawn");
    expect(drawn.at(-1)).toMatchObject({ kind: "signed-in", provider: "google" });
    expect(names(drawn.at(-1))).not.toContain("acct-a's PC");
  });

  it("draws B's heading alone once A's answer lands after another tab signed in as B, while B's read is still out", async () => {
    const account = await withAsList();
    const held = Promise.withResolvers<"rows" | "503">();
    answers["acct-a"] = held.promise;
    answers["acct-b"] = new Promise(() => {});
    void account.refresh(false, true);
    await until(() => asked.length === 2, "A's directory asked again");
    await accountStore.set("session", session("acct-b"));
    held.resolve("rows");
    await until(() => asked.at(-1) === "acct-b", "B's directory asked");
    expect(drawn.at(-1)).toMatchObject({ kind: "signed-in", provider: "google", pcs: null });
  });
});
