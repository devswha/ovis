import { afterEach, expect, spyOn, test } from "bun:test";
import { nativeTransport, setTransport } from "../transport.ts";
import { moveFromGoneAccount } from "./movePc.ts";
import type { AccountService } from "./service.ts";

afterEach(() => setTransport(nativeTransport));

/** The PC's answers, and every move it was asked for: a prepare is answered `aborted`, so no move goes further. */
async function asked(status: Record<string, unknown>, moveStatus: Record<string, unknown>, signedIn: string | undefined): Promise<unknown[]> {
  const moves: unknown[] = [];
  const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/account/status") return Response.json({ unlinked: [], removals: [], adds: [], blocked: [], ...status });
    if (path === "/api/account/move" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { into: string };
      moves.push(body);
      return Response.json({ state: "aborted", account: body.into, reason: "cancelled" });
    }
    if (path === "/api/account/move") return Response.json(moveStatus);
    return Response.json({});
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  const service = { session: async () => signedIn === undefined ? undefined : { account: signedIn, provider: "github" } } as unknown as AccountService;
  try {
    await moveFromGoneAccount(new AbortController().signal, service);
  } finally { fetchSpy.mockRestore(); }
  return moves;
}

test("a PC whose account is gone is moved into the account its own window is signed in to", async () => {
  expect(await asked({ account: "acct_gone", account_gone: true }, { into: null }, "acct_now"))
    .toEqual([{ into: "acct_now", provider: "github", stage: "prepare" }]);
});

test("a PC in an account that still exists, or in the window's own, or signed out of, is not moved", async () => {
  expect(await asked({ account: "acct_other" }, { into: null }, "acct_now")).toEqual([]);
  expect(await asked({ account: "acct_now", account_gone: true }, { into: null }, "acct_now")).toEqual([]);
  expect(await asked({ account: "acct_gone", account_gone: true }, { into: null }, undefined)).toEqual([]);
});

test("a move into that account given up before is not tried again by itself", async () => {
  expect(await asked({ account: "acct_gone", account_gone: true }, { into: null, aborted: { state: "aborted", account: "acct_now", reason: "relay_limit" } }, "acct_now")).toEqual([]);
});
