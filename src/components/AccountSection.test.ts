import { expect, it } from "bun:test";

import { reachabilityProbe } from "./AccountSection.tsx";

// the relay tab offers the relay's own pairing while the account service cannot be reached (ConnectPhoneDialog's RelayTab)
it("counts an answer the service could give as reachable, and a server error or no answer as not", async () => {
  const seen: boolean[] = [];
  const answering = (status: number) => reachabilityProbe((reachable) => seen.push(reachable), Object.assign(async () => new Response(null, { status }), { preconnect: fetch.preconnect }));
  await answering(200)("https://account.example/v1/providers");
  await answering(404)("https://account.example/v1/providers");
  await answering(503)("https://account.example/v1/providers");
  await answering(502)("https://account.example/v1/providers");
  const offline = reachabilityProbe((reachable) => seen.push(reachable), Object.assign(async (): Promise<Response> => { throw new TypeError("offline"); }, { preconnect: fetch.preconnect }));
  await expect(offline("https://account.example/v1/providers")).rejects.toThrow("offline");
  expect(seen).toEqual([true, true, false, false, false]);
});
