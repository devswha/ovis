import { describe, expect, it } from "bun:test";

import { addressOf } from "./RelayAddPc.tsx";

describe("an address typed on Add a PC", () => {
  it("reads it as people write it: http for a bare IPv4 address, https for a name, a whole URL as it is", () => {
    const read = (text: string) => addressOf(text)?.href ?? null;
    expect(read("192.168.0.12:7421")).toBe("http://192.168.0.12:7421/");
    expect(read(" 100.101.102.103 ")).toBe("http://100.101.102.103/");
    expect(read("my-pc.tailnet.ts.net")).toBe("https://my-pc.tailnet.ts.net/");
    expect(read("my-pc.tailnet.ts.net:8443")).toBe("https://my-pc.tailnet.ts.net:8443/");
    expect(read("http://my-pc.local:7421")).toBe("http://my-pc.local:7421/");
  });

  it("takes nothing that is not an http or https address", () => {
    for (const text of ["", "   ", "javascript:alert(1)", "ftp://pc.example", "https://"]) expect(addressOf(text)).toBeNull();
  });
});
