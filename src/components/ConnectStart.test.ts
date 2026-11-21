import { describe, expect, it } from "bun:test";

import type { MyPc } from "../lib/account/myPcs.ts";
import { phoneSavedPcs, relayTabPcs } from "./ConnectStart.tsx";

const id = (letter: string) => letter.repeat(32);
const accountPc = (letter: string, patch: Partial<MyPc> = {}) => ({ server_id: id(letter), name: `pc-${letter}`, state: "paired", paired: false, listed: true, linked: false, join: { relay: "wss://relay.ovis.sh" }, ...patch }) as unknown as MyPc;

describe("the relay tab's PCs this phone is on", () => {
  it("lists the PCs this phone paired (by a code too) and, signed in, the account's PCs it can open", () => {
    const rows = relayTabPcs([{ server_id: id("a"), name: "code-paired" }], [accountPc("b"), accountPc("c", { state: "offline" })]);
    expect(rows.map((row) => [row.name, row.status ?? "", row.saved])).toEqual([["code-paired", "", true], ["pc-b", "online", false], ["pc-c", "off", false]]);
  });

  it("lists an account PC this phone also paired once, as the phone's own", () => {
    const rows = relayTabPcs([{ server_id: id("a"), name: "code-paired" }, { server_id: id("b"), name: "desk", status: "online" }], [accountPc("b", { paired: true }), accountPc("c")]);
    expect(rows.map((row) => row.server_id)).toEqual([id("a"), id("b"), id("c")]);
    expect(rows.filter((row) => row.saved).length).toBe(2);
  });

  it("lists none of the account's PCs signed out, nor one it cannot open", () => {
    expect(relayTabPcs([{ server_id: id("a") }], null).length).toBe(1);
    const unopenable = accountPc("b");
    expect(relayTabPcs([], [{ ...unopenable, join: undefined } as MyPc]).length).toBe(0);
  });
});

describe("the phone app's PCs on the Tailscale and SSH tabs", () => {
  it("sorts what the app saved by the way it connects, the app's own pages and an unreadable entry on neither", () => {
    const saved = ["https://desk.tail1e211e.ts.net", "http://100.101.1.2:7317", "http://192.168.0.5:7317", "http://127.0.0.1:41234", `https://app.ovis.sh/s/${id("a")}/`, "not an address"];
    const rows = phoneSavedPcs(saved, { "https://desk.tail1e211e.ts.net": "Desk" }, "https://app.ovis.sh");
    expect(rows.map((row) => [row.name, row.way])).toEqual([["Desk", "tailscale"], ["100.101.1.2:7317", "tailscale"], ["192.168.0.5:7317", "address"], ["127.0.0.1:41234", "ssh"]]);
  });
});
