import { expect, it } from "bun:test";
import { regionalAppUrl } from "./relay-regions.ts";

const ID = "0123456789abcdef".repeat(2);
const link = (offer: unknown) => `#offer=${btoa(JSON.stringify(offer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
const at = (hash: string, origin = "https://app.ovis.sh", pathname = `/s/${ID}/`) => ({ origin, pathname, hash });
const pairing = { v: 1, server_id: ID, server_public_key: "k", relay: "wss://relay-ap.ovis.sh", code: "123456" };

it("opens a pairing link for a regional relay on the app's copy beside it, the fragment kept", () => {
  const hash = link(pairing);
  expect(regionalAppUrl(at(hash), false)).toBe(`https://app-ap.ovis.sh/s/${ID}/${hash}`);
});

it("leaves every other page where it is", () => {
  for (const [location, native] of [
    [at(link(pairing)), true],
    [at(link({ ...pairing, relay: "wss://relay.ovis.sh" })), false],
    [at(link({ ...pairing, code: undefined })), false],
    [at(link(pairing), "https://app-ap.ovis.sh"), false],
    [at(link(pairing), "https://pc.example.ts.net"), false],
    [at(link(pairing), "https://app.ovis.sh", "/"), false],
    [at(""), false],
    [at("#offer=not*base64"), false],
    [at(link([1])), false],
  ] as const) expect([location, regionalAppUrl(location, native)]).toEqual([location, null]);
});
