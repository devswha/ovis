import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  VERIFY_MATRIX,
  applySanitizedVerifyEnv,
  assertSafeVerifyUrl,
  parseVerifyArgs,
  resolveTargetUrl,
  sanitizedVerifyEnv,
  selectMatrixCells,
} from "./verify-ui.ts";

describe("verify-ui URL and environment guards", () => {
  it("accepts loopback and own-tailnet addresses and rejects wildcard, LAN, funnel or external hosts", () => {
    const ownTailnet = { tailnetSuffix: "tail0example.ts.net" } as const;
    expect(assertSafeVerifyUrl("http://127.0.0.1:43123/app/", ownTailnet).hostname).toBe("127.0.0.1");
    expect(assertSafeVerifyUrl("http://localhost:5173/", ownTailnet).hostname).toBe("localhost");
    expect(assertSafeVerifyUrl("http://[::1]:7317/", ownTailnet).hostname).toBe("[::1]");
    expect(assertSafeVerifyUrl("http://100.64.0.1:49152/", ownTailnet).hostname).toBe("100.64.0.1");
    expect(assertSafeVerifyUrl("http://100.101.202.45:8123/", ownTailnet).hostname).toBe("100.101.202.45");
    expect(assertSafeVerifyUrl("https://home-server.tail0example.ts.net:17421/", ownTailnet).hostname).toBe("home-server.tail0example.ts.net");

    expect(() => assertSafeVerifyUrl("https://stranger.tail99999.ts.net/", ownTailnet)).toThrow("Refusing non-local/non-tailnet host");
    expect(() => assertSafeVerifyUrl("https://home-server.tail0example.ts.net:17421/", { tailnetSuffix: null })).toThrow("Refusing non-local/non-tailnet host");
    expect(() => assertSafeVerifyUrl("http://user:pass@127.0.0.1:7317/", ownTailnet)).toThrow("embedded credentials");
    expect(() => assertSafeVerifyUrl("http://0.0.0.0:7317/", ownTailnet)).toThrow("Refusing wildcard host");
    expect(() => assertSafeVerifyUrl("http://0:7317/", ownTailnet)).toThrow("Refusing wildcard host");
    expect(() => assertSafeVerifyUrl("http://[::]:7317/", ownTailnet)).toThrow("Refusing wildcard host");
    expect(() => assertSafeVerifyUrl("http://[::ffff:0.0.0.0]:7317/", ownTailnet)).toThrow("Refusing wildcard host");
    expect(() => assertSafeVerifyUrl("http://192.168.1.20:7317/", ownTailnet)).toThrow("Refusing non-local/non-tailnet host");
    expect(() => assertSafeVerifyUrl("http://100.63.255.255:7317/", ownTailnet)).toThrow("Refusing non-local/non-tailnet host");
    expect(() => assertSafeVerifyUrl("http://100.128.0.1:7317/", ownTailnet)).toThrow("Refusing non-local/non-tailnet host");
    expect(() => assertSafeVerifyUrl("https://example.com/", ownTailnet)).toThrow("Refusing non-local/non-tailnet host");
    expect(() => assertSafeVerifyUrl("file:///etc/passwd", ownTailnet)).toThrow("must use http: or https:");
  });

  it("keeps --path on the base origin and blocks scheme, backslash and protocol-relative escapes", () => {
    const base = "http://127.0.0.1:9999/app/#initial";
    expect(resolveTargetUrl(base, "#settings")).toBe("http://127.0.0.1:9999/app/#settings");
    expect(resolveTargetUrl(base, "?pane=p1")).toBe("http://127.0.0.1:9999/app/?pane=p1#initial");
    expect(resolveTargetUrl("http://127.0.0.1:9999/app", "files/readme")).toBe("http://127.0.0.1:9999/app/files/readme");

    expect(() => resolveTargetUrl(base, "https://evil.example/pwn")).toThrow("must be a relative path");
    expect(() => resolveTargetUrl(base, "http://0.0.0.0:7317/")).toThrow("must be a relative path");
    expect(() => resolveTargetUrl(base, "javascript:alert(1)")).toThrow("must be a relative path");
    expect(() => resolveTargetUrl(base, "//evil.example/pwn")).toThrow("must be a relative path");
    expect(() => resolveTargetUrl(base, "/\\\\evil.example")).toThrow("must not contain backslashes");
  });

  it("strips inherited herdr and herdr-core variables in place and refuses wildcard or LAN HOST binds", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      HERDR_SOCKET: "/run/user/1000/herdr.sock",
      HERDR_SOCKET_PATH: "/run/user/1000/herdr.sock",
      HERDR_SESSION: "main",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "p1",
      HERDR_TAB_ID: "t1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_CONFIG_PATH: "/home/tester/.config/herdr/config.toml",
      HERDR_TEST_LIVE: "1",
      HC_SOCKET: "/run/user/1000/hc.sock",
      HC_SESSION: "default",
      OVIS_ALLOW_LIVE_HERDR: "1",
    };

    expect(sanitizedVerifyEnv(env, { TMPDIR: "/home/tester/.cache/ovis-tmp/qa" })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      TMPDIR: "/home/tester/.cache/ovis-tmp/qa",
    });

    const restore = applySanitizedVerifyEnv(env);
    expect(env["HERDR_SOCKET"]).toBeUndefined();
    expect(env["HC_SOCKET"]).toBeUndefined();
    expect(env["OVIS_ALLOW_LIVE_HERDR"]).toBeUndefined();
    restore();
    expect(env["HERDR_SOCKET"]).toBe("/run/user/1000/herdr.sock");
    expect(env["HC_SOCKET"]).toBe("/run/user/1000/hc.sock");

    expect(() => sanitizedVerifyEnv({ HOST: "0.0.0.0" })).toThrow("never 0.0.0.0");
    expect(() => sanitizedVerifyEnv({ HOST: "0" })).toThrow("never 0.0.0.0");
    expect(() => sanitizedVerifyEnv({ HOST: "::" })).toThrow("never 0.0.0.0");
    expect(() => sanitizedVerifyEnv({ HOST: "::ffff:0.0.0.0" })).toThrow("never 0.0.0.0");
    expect(() => sanitizedVerifyEnv({ HOST: "192.168.1.10" })).toThrow("never 0.0.0.0");
    expect(sanitizedVerifyEnv({ HOST: "127.0.0.1" })["HOST"]).toBe("127.0.0.1");
    expect(sanitizedVerifyEnv({ HOST: "100.100.1.2" })["HOST"]).toBe("100.100.1.2");
  });

  it("parses matrix subsets, evidence paths, labels and missing flag values", () => {
    expect(selectMatrixCells(undefined).map((cell) => cell.id)).toEqual(VERIFY_MATRIX.map((cell) => cell.id));
    expect(selectMatrixCells("desktop-dark,phone-light").map((cell) => cell.id)).toEqual(["desktop-dark", "phone-light"]);
    expect(() => selectMatrixCells("tablet-sepia")).toThrow("Unknown matrix cell");

    const parsed = parseVerifyArgs(
      ["--url", "http://127.0.0.1:9999/app/", "--path", "#settings", "--label", "after", "--matrix", "phone-dark", "--json"],
      { UI_EVIDENCE_DIR: "/tmp/ev-test" },
    );
    expect(parsed.url).toBe("http://127.0.0.1:9999/app/");
    expect(parsed.pathSuffix).toBe("#settings");
    expect(parsed.label).toBe("after");
    expect(parsed.cells.map((cell) => cell.id)).toEqual(["phone-dark"]);
    expect(parsed.evidenceDir).toBe(resolve("/tmp/ev-test"));
    expect(parsed.json).toBe(true);

    expect(() => parseVerifyArgs(["--evidence", "--json"])).toThrow("--evidence requires a value");
    expect(() => parseVerifyArgs(["--url", "--json"])).toThrow("--url requires a value");
    expect(() => parseVerifyArgs(["--url", "http://127.0.0.1:9999/app/", "--path", "https://evil.example/"])).toThrow("must be a relative path");
  });
});
