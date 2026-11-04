import { describe, expect, it } from "bun:test";

import { connectionRoute } from "./connectionRoute.ts";

const route = (hostname: string, relay = false) => connectionRoute({ relay, hostname });

describe("how this device reaches Ovis", () => {
  it("is the relay on the hosted shell, whatever its address", () => {
    expect(route("app.ovis.sh", true)).toBe("relay");
    expect(route("localhost", true)).toBe("relay");
  });

  it("is this PC on a loopback address", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "app.localhost"]) expect(route(host)).toBe("local");
  });

  it("is Tailscale on its address ranges and MagicDNS names, and not just outside them", () => {
    for (const host of ["pc.tail1e211e.ts.net", "100.106.153.26", "100.64.0.1", "100.127.255.254", "[fd7a:115c:a1e0::1]"]) expect(route(host)).toBe("tailscale");
    expect(route("100.63.0.1")).toBe("direct");
    expect(route("100.128.0.1")).toBe("direct");
  });

  it("is the local network on private addresses and local names", () => {
    for (const host of ["192.168.0.10", "10.0.0.5", "172.16.1.1", "172.31.0.1", "169.254.1.1", "home-server", "pc.local", "nas.lan", "box.home.arpa", "[fe80::1]", "[fd12::1]"]) expect(route(host)).toBe("lan");
    expect(route("172.32.0.1")).toBe("direct");
  });

  it("is direct for any other address: a public name or a proxy in front of the PC", () => {
    for (const host of ["ovis.example.com", "8.8.8.8", "[2001:db8::1]"]) expect(route(host)).toBe("direct");
  });
});
