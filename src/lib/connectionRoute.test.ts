import { describe, expect, it } from "bun:test";

import { connectionRoute } from "./connectionRoute.ts";

const route = (hostname: string, page: { relay?: boolean; portal?: boolean; funnel?: boolean; protocol?: string } = {}) =>
  connectionRoute({ relay: false, portal: false, funnel: false, protocol: "https:", hostname, ...page });

describe("how this device reaches Ovis", () => {
  it("is the relay on the hosted shell, and Portal for a Portal sign-in, whatever the address", () => {
    expect(route("app.ovis.sh", { relay: true })).toBe("relay");
    expect(route("localhost", { relay: true })).toBe("relay");
    expect(route("herdr-test.relay.example", { portal: true })).toBe("portal");
  });

  it("says nothing in the phone app's bundled demo, which reaches no PC", () => {
    expect(route("localhost", { protocol: "capacitor:" })).toBeNull();
  });

  it("is direct for a request the server saw come through Tailscale Funnel, though its name is a tailnet one", () => {
    expect(route("pc.tail1e211e.ts.net", { funnel: true })).toBe("direct");
  });

  it("is local on a loopback address: this PC, or a tunnel to another", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "app.localhost"]) expect(route(host)).toBe("local");
  });

  it("is Tailscale on its address ranges and MagicDNS names, and not just outside them", () => {
    for (const host of ["pc.tail1e211e.ts.net", "100.106.153.26", "100.64.0.1", "100.127.255.254", "[fd7a:115c:a1e0::1]"]) expect(route(host)).toBe("tailscale");
    expect(route("100.63.0.1")).toBe("direct");
    expect(route("100.128.0.1")).toBe("direct");
  });

  it("is the local network on private addresses and names only it answers", () => {
    for (const host of ["192.168.0.10", "10.0.0.5", "172.16.1.1", "172.31.0.1", "169.254.1.1", "pc.local", "nas.lan", "box.home.arpa", "[fe80::1]", "[fd12::1]"]) expect(route(host)).toBe("lan");
    expect(route("172.32.0.1")).toBe("direct");
  });

  it("is direct for any other address, a bare machine name included: it may be a LAN host or a MagicDNS short name", () => {
    for (const host of ["ovis.example.com", "8.8.8.8", "[2001:db8::1]", "home-server"]) expect(route(host)).toBe("direct");
  });
});
