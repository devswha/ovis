import { expect, it } from "bun:test";
import { pairQrUrl, tailnetPairTarget } from "../app/web/tailnet-pair.js";

it("keeps private HTTP and custom HTTPS addresses direct, not public redirect destinations", () => {
  for (const base of ["http://100.100.1.2:7317", "http://pc.local", "https://pc.example.org"]) {
    expect(pairQrUrl(base + "/", "002345")).toBe(`${base}/?pair=002345`);
  }
});

it("allows only an exact hosted handoff containing a tailnet authority and six digits", () => {
  const base = "https://app.ovis.sh/t/#";
  expect(tailnetPairTarget(base + "pc.tailnet.ts.net:443/000123")?.href).toBe("https://pc.tailnet.ts.net/?pair=000123");
  for (const authority of ["https://pc.tailnet.ts.net", "//other.example", "evilts.net", "ts.net",
    "pc.ts.net.example", "pc.ts.net@other.example", "user@pc.ts.net", "pc.ts.net\\@example.org",
    "evil.example%2Fpc.ts.net", "pc.ts.net.", "-bad.ts.net", "pc..ts.net", "pc.ts.net:", "pc.ts.net:0",
    "pc.ts.net:65536", "pc.ts.net:abc", "pc.ts.net/path", "pc.ts.net?x=", "pc.ts.net#x"]) {
    expect(tailnetPairTarget(base + authority + "/123456")).toBeNull();
  }
  for (const code of ["", "12345", "1234567", "123456&next=elsewhere", "%31%32%33%34%35%36"]) {
    expect(tailnetPairTarget(base + "pc.ts.net/" + code)).toBeNull();
  }
  for (const url of [base.replace("/#", "/?x=#"), base.replace("//app", "//user@app"), base.replace("https:", "http:")]) {
    expect(tailnetPairTarget(url + "pc.ts.net/123456")).toBeNull();
  }
});
