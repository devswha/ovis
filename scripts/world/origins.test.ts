import { describe, expect, it } from "bun:test";
import { PlanError } from "./constants.ts";
import { caddyfile, DEFAULT_ORIGINS, originsFrom, parseOrigin, proxyNames, sitesFrom } from "./origins.ts";
import { HOSTS } from "./plan.ts";

const M2 = ["app=https://home-server.tail1e211e.ts.net:17541", "account=https://home-server.tail1e211e.ts.net:17542",
  "relay=wss://home-server.tail1e211e.ts.net:17543", "kit=https://home-server.tail1e211e.ts.net:17544"];

describe("given origins (R13)", () => {
  it("takes the four M2 origins exactly and keeps the world's own names otherwise", () => {
    const origins = originsFrom(M2);
    expect(origins.relay).toEqual({ url: "wss://home-server.tail1e211e.ts.net:17543", host: "home-server.tail1e211e.ts.net", port: 17543 });
    expect(origins.kit?.port).toBe(17544);
    expect(originsFrom([])).toEqual(DEFAULT_ORIGINS);
    expect(parseOrigin("account=https://account.example")[1]).toEqual({ url: "https://account.example", host: "account.example", port: 443 });
    expect(proxyNames(origins, [HOSTS.staging])).toEqual(["home-server.tail1e211e.ts.net", HOSTS.staging]);
  });

  it("refuses what is not an origin of the right kind", () => {
    for (const bad of ["relay=https://a:1", "account=wss://a:1", "app=https://a:1/path", "kit=https://u:p@a:1", "web=https://a", "account", "app=not a url"]) {
      expect(() => originsFrom([bad])).toThrow(PlanError);
    }
    expect(() => originsFrom(["app=https://a:1", "app=https://a:2"])).toThrow(PlanError);
    expect(() => originsFrom(["app=https://a:1", "kit=https://a:1"])).toThrow(PlanError);
  });

  it("serves app and kit only with a folder, and a folder only with its origin", () => {
    const origins = originsFrom(M2);
    expect(sitesFrom(["app=/a", "kit=/k"], origins)).toEqual({ app: "/a", kit: "/k" });
    expect(() => sitesFrom(["app=/a"], origins)).toThrow(PlanError);
    expect(() => sitesFrom(["kit=/k"], originsFrom([]))).toThrow(PlanError);
  });

  it("gives the proxy one site per origin, the kit as files a browser never runs", () => {
    const text = caddyfile({ bind: "10.243.1.10", relay: "10.243.1.11", account: "10.243.1.12" }, originsFrom(M2));
    expect(text).toContain("https://home-server.tail1e211e.ts.net:17543 {\n\ttls /certs/cert.pem /certs/key.pem\n\treverse_proxy 10.243.1.11:8787\n}");
    expect(text).toContain("https://home-server.tail1e211e.ts.net:17542 {\n\ttls /certs/cert.pem /certs/key.pem\n\treverse_proxy 10.243.1.12:9080\n}");
    const kit = text.slice(text.indexOf(":17544 {"));
    expect(kit).toContain("Content-Type application/octet-stream");
    expect(kit).toContain("X-Content-Type-Options nosniff");
    expect(kit).not.toContain("browse");
  });

  it("gives the real account service its own address as Host, and only it", () => {
    const text = caddyfile({ bind: "10.243.1.10", relay: "10.243.1.11", account: "10.243.1.12", accountHostIsItsOwn: true }, originsFrom(M2));
    expect(text).toContain("https://home-server.tail1e211e.ts.net:17542 {\n\ttls /certs/cert.pem /certs/key.pem\n\treverse_proxy 10.243.1.12:9080 {\n\t\theader_up Host {upstream_hostport}\n\t}\n}");
    expect(text).toContain("https://home-server.tail1e211e.ts.net:17543 {\n\ttls /certs/cert.pem /certs/key.pem\n\treverse_proxy 10.243.1.11:8787\n}");
  });
});
