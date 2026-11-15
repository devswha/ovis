import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headerLines, serverCallArgv, type ServerCall } from "./machines.ts";

// the argv Machine.serverCall builds, run here with inside/serve-call.sh's own copy (sh, curl) against fake servers on
// TCP and on unix sockets: what reaches which server, with which Host, and what is on the command line
const SCRIPT = join(import.meta.dir, "inside", "serve-call.sh");
const servers: { stop(force?: boolean): void }[] = [];
const folders: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const folder = () => { const made = mkdtempSync(join(tmpdir(), "serve-call-")); folders.push(made); return made; };

/** A fake server that answers who it is and what it was sent: method, path, Host, the x-probe header, the body. */
function fake(name: string, unix?: string): { readonly port: number } {
  const fetch = async (request: Request) => new Response(`${name} ${request.method} ${new URL(request.url).pathname} host=${request.headers.get("host")} probe=${request.headers.get("x-probe") ?? "-"} body=${await request.text()}`);
  const server = unix === undefined ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }) : Bun.serve({ unix, fetch });
  servers.push(server);
  return { port: unix === undefined ? server.port! : 0 };
}

/** One call as serverCall makes it: the headers in a 0600 file, the body on stdin. */
async function call(route: string, server: ServerCall): Promise<{ code: number; status: number; body: string; err: string; argv: string[] }> {
  const lines = headerLines(server.headers ?? {});
  let file: string | null = null;
  if (lines !== "") { file = join(folder(), "headers"); writeFileSync(file, lines, { mode: 0o600 }); }
  const argv = serverCallArgv(route, server, file, SCRIPT);
  const child = Bun.spawn(argv, { stdin: server.body === undefined ? "ignore" : new TextEncoder().encode(server.body), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const at = out.lastIndexOf("\n");
  return { code, status: Number(out.slice(at + 1)), body: out.slice(0, at), err, argv };
}

describe("a call to the server a caller names (Machine.serverCall, inside/serve-call.sh)", () => {
  it("reaches the one named of two servers: one on TCP only, one with a socket in another state folder", async () => {
    const plain = folder();
    const door = folder();
    const tcpOnly = fake("tcp-only");
    const doorTcp = fake("door-tcp");
    fake("door-socket", join(door, "serve.sock"));
    expect((await call("/api/devices", { state: plain, port: tcpOnly.port })).body).toBe(`tcp-only GET /api/devices host=127.0.0.1:${tcpOnly.port} probe=- body=`);
    expect((await call("/api/devices", { state: door, port: doorTcp.port })).body).toBe(`door-socket GET /api/devices host=127.0.0.1:${doorTcp.port} probe=- body=`);
    // and the other way round once more: naming the first again reaches it, not the one with the socket
    expect((await call("/api/session", { state: plain, port: tcpOnly.port })).body).toStartWith("tcp-only GET /api/session");
  });

  it("through the socket sends the TCP URL's Host, so the Origin a caller sends matches it", async () => {
    const door = folder();
    const tcp = fake("tcp");
    fake("socket", join(door, "serve.sock"));
    const answer = await call("/api/relay/direct", { state: door, port: tcp.port, method: "POST", body: '{"on":true}', headers: { "x-probe": "from-file", origin: `http://127.0.0.1:${tcp.port}` } });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe(`socket POST /api/relay/direct host=127.0.0.1:${tcp.port} probe=from-file body={"on":true}`);
  });

  it("puts no header value on the command line: the headers go by their 0600 file's name", async () => {
    const tcp = fake("tcp");
    const secret = `Bearer secret-${crypto.randomUUID()}`;
    const answer = await call("/api/devices", { state: folder(), port: tcp.port, headers: { authorization: secret, "x-probe": "seen" } });
    expect(answer.body).toContain("probe=seen");
    expect(answer.argv.some((arg) => arg.includes("secret-") || arg.includes("seen"))).toBe(false);
    expect(answer.argv).toContain("-H");
    expect(answer.argv.find((arg) => arg.startsWith("@"))).toMatch(/headers$/);
    expect(() => headerLines({ "x-bad\nname": "v" })).toThrow();
    expect(() => headerLines({ "x-probe": "a\r\nx-injected: 1" })).toThrow();
  });

  it("refuses a server it cannot name: no state folder, no port, a route without /", async () => {
    expect(() => serverCallArgv("/api/devices", { state: "relative", port: 17611 }, null)).toThrow();
    expect(() => serverCallArgv("/api/devices", { state: "/s", port: 0 }, null)).toThrow();
    expect(() => serverCallArgv("/api/devices", { state: "/s", port: 17611, method: "GET /x" }, null)).toThrow();
    const refused = await call("api/devices", { state: folder(), port: 9 });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("a route starts with /");
  });

  it("takes TCP when serve.sock is a plain file, and fails loudly when serve.sock is a socket nothing answers on", async () => {
    const tcp = fake("tcp");
    const plainFile = folder();
    writeFileSync(join(plainFile, "serve.sock"), "");
    expect((await call("/api/session", { state: plainFile, port: tcp.port })).body).toStartWith("tcp GET /api/session");
    // a socket file whose server is gone: bound, never listened on, its process ended
    const stale = folder();
    const bound = Bun.spawnSync(["python3", "-c", "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", join(stale, "serve.sock")]);
    expect(bound.exitCode).toBe(0);
    const failed = await call("/api/session", { state: stale, port: tcp.port });
    expect(failed.code).toBe(7);
    expect(failed.err).toContain("serve.sock exists but nothing answers on it");
    expect(failed.body).not.toContain("tcp GET");
  });
});
