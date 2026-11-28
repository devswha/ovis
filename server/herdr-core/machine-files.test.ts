import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as herdr from "../herdr/client.ts";
import { HerdrError } from "../herdr/client.ts";
import { createServer } from "../index.ts";
import { HcReplyError } from "./connection.ts";
import type { MachineHc } from "./machine-files.ts";

/**
 * The machine's core, played by this PC: `machine.exec` runs its argv here, as hc runs it on that machine,
 * so the script the server sends is the one tested; `terminal.put` answers as hc does.
 */
function core(methods = ["machine.exec", "terminal.put"], refusePut: string | null = null, path = process.env["PATH"]) {
  const puts: Record<string, unknown>[] = [];
  const hc: MachineHc = {
    hello: async () => ({ version: "0.1.18", core: { id: "core", name: "core" }, methods, features: [] }),
    call: (async (method: string, params: Record<string, unknown>) => {
      if (method === "machine.exec") {
        const proc = Bun.spawn(params["argv"] as string[], { env: { ...process.env, PATH: path, ...(params["env"] as Record<string, string>) }, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).bytes(), proc.exited]);
        const kept = 8_000_000;
        return { code, signal: null, ms: 1, timed_out: false, truncated: stdout.byteLength > kept, stdout: Buffer.from(stdout.subarray(0, kept)).toString("base64"), stderr: Buffer.from(stderr).toString("base64") };
      }
      if (method === "terminal.put") {
        puts.push(params);
        if (refusePut !== null) throw new HcReplyError(refusePut, refusePut);
        return { path: `/home/lab/.local/state/herdr-core/files/${String(params["terminal"])}/${String(params["name"])}`, bytes: Buffer.from(String(params["data"]), "base64").byteLength };
      }
      throw new HcReplyError("unknown_method", `unknown method "${method}"`);
    }) as MachineHc["call"],
  };
  return { hc, puts };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

describe("the files of another machine of herdr-core (#4905, #4504)", () => {
  const token = "t".repeat(64);
  let dir: string;
  let folder: string;
  const servers: ReturnType<typeof createServer>[] = [];
  const serve = (hc: MachineHc) => {
    const server = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, bridgeOnly: true, localFiles: false, machineFiles: () => hc, stateDir: join(dir, `state-${servers.length}`) });
    servers.push(server);
    return (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers as Record<string, string> } });
  };
  const q = encodeURIComponent;
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
  const paste = (ask: ReturnType<typeof serve>, body: Record<string, unknown>) => ask("/api/pane/image", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ovis-machine-files-"));
    folder = join(dir, "project");
    mkdirSync(join(folder, "sub"), { recursive: true });
    mkdirSync(join(folder, ".hidden"));
    writeFileSync(join(folder, "a.txt"), "hello");
    writeFileSync(join(folder, "with space.png"), PNG);
    writeFileSync(join(folder, ".env"), "secret");
    writeFileSync(join(folder, "big.bin"), Buffer.alloc(8_000_001));
    writeFileSync(join(folder, "zeros.bin"), Buffer.alloc(3_000_000));
    writeFileSync(join(folder, "long.txt"), "x".repeat(20_000));
    symlinkSync("a.txt", join(folder, "link.txt"));
    symlinkSync("nowhere", join(folder, "broken"));
  });
  afterAll(() => {
    for (const server of servers) server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists a folder there, with its files and without hidden names unless asked, with GNU find or without it (macOS)", async () => {
    // a find that takes no -printf, as BSD's and BusyBox's do not
    const shims = join(dir, "bsd-find");
    mkdirSync(shims, { recursive: true });
    writeFileSync(join(shims, "find"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    for (const ask of [serve(core().hc), serve(core(undefined, null, `${shims}:${process.env["PATH"]}`).hc)]) {
      const listed = await ask(`/api/workspace/directories?path=${q(join(folder, "sub", ".."))}&files=1`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        path: folder, parent: dir, home: process.env["HOME"],
        directories: ["sub"], truncated: false,
        files: [{ name: "a.txt", size: 5 }, { name: "big.bin", size: 8_000_001 }, { name: "link.txt", size: 5 }, { name: "long.txt", size: 20_000 }, { name: "with space.png", size: PNG.byteLength }, { name: "zeros.bin", size: 3_000_000 }],
      });
    }
    const bsd = serve(core(undefined, null, `${shims}:${process.env["PATH"]}`).hc);
    expect(await (await bsd(`/api/workspace/directories?path=${q(folder)}&hidden=1`)).json()).toMatchObject({ directories: [".hidden", "sub"] });
    const ask = serve(core().hc);
    const hidden = await (await ask(`/api/workspace/directories?path=${q(folder)}&hidden=1`)).json() as { directories: string[]; files?: unknown };
    expect(hidden.directories).toEqual([".hidden", "sub"]);
    expect(hidden.files).toBeUndefined();
    expect(await error(await ask(`/api/workspace/directories?path=${q(join(folder, "a.txt"))}`))).toEqual([400, "invalid_cwd"]);
    expect(await error(await ask(`/api/workspace/directories?path=relative`))).toEqual([400, "invalid_cwd"]);
  });

  it("describes and sends a file there, as this PC's own are sent", async () => {
    const ask = serve(core().hc);
    const file = join(folder, "a.txt");
    expect(await (await ask(`/api/fs/stat?path=${q(file)}`)).json()).toMatchObject({ path: file, name: "a.txt", size: 5, kind: "text", mime: "text/plain" });
    expect(await (await ask(`/api/fs/stat?path=${q(join(folder, "with space.png"))}`)).json()).toMatchObject({ name: "with space.png", kind: "image", mime: "image/png" });
    expect(await (await ask(`/api/fs/stat?path=${q(join(folder, "link.txt"))}`)).json()).toMatchObject({ name: "link.txt", size: 5 });
    const sent = await ask(`/api/fs/file?path=${q(file)}`);
    expect(await sent.text()).toBe("hello");
    expect(sent.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(sent.headers.get("content-security-policy")).toStartWith("sandbox");
    expect(sent.headers.get("content-disposition")).toStartWith("inline;");
    expect((await ask(`/api/fs/file?path=${q(file)}&download=1`)).headers.get("content-disposition")).toStartWith("attachment;");
    const range = await ask(`/api/fs/file?path=${q(file)}`, { headers: { range: "bytes=1-2" } });
    expect([range.status, range.headers.get("content-range"), await range.text()]).toEqual([206, "bytes 1-2/5", "el"]);
    const head = await ask(`/api/fs/file?path=${q(file)}`, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length")]).toEqual([200, "5"]);
    const image = await ask(`/api/fs/file?path=${q(join(folder, "with space.png"))}`);
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
    // a file of NULs is sent as it is, at once: its bytes are never split on them
    const zeros = await ask(`/api/fs/file?path=${q(join(folder, "zeros.bin"))}`);
    expect(Buffer.from(await zeros.arrayBuffer()).equals(Buffer.alloc(3_000_000))).toBe(true);
    // HEAD tells the whole file's length, and refuses what GET would
    const longHead = await ask(`/api/fs/file?path=${q(join(folder, "long.txt"))}`, { method: "HEAD" });
    expect([longHead.status, longHead.headers.get("content-length")]).toEqual([200, "20000"]);
    expect((await ask(`/api/fs/file?path=${q(join(folder, "big.bin"))}`, { method: "HEAD" })).status).toBe(413);
  }, 10_000);

  it("reads a relative path from the folder of the pane it belongs to there", async () => {
    const ask = serve(core().hc);
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => ({ pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", cwd: folder, agent_status: "idle" }) as unknown as Awaited<ReturnType<typeof herdr.paneGet>>);
    try {
      expect(await (await ask("/api/fs/stat?pane_id=t3&path=sub%2F..%2Fa.txt")).json()).toMatchObject({ path: join(folder, "a.txt"), size: 5 });
      expect(await (await ask("/api/workspace/directories?pane_id=t3&path=sub")).json()).toMatchObject({ path: join(folder, "sub"), parent: folder });
      get.mockImplementation(async (paneId) => { throw new HerdrError("pane_not_found", `pane ${paneId} not found`); });
      expect(await error(await ask("/api/fs/stat?pane_id=t3&path=a.txt"))).toEqual([404, "pane_unknown"]);
      expect(await error(await ask("/api/workspace/directories?pane_id=t3&path=sub"))).toEqual([400, "invalid_cwd"]);
    } finally { get.mockRestore(); }
  });

  it("says when there is no readable file, and sends none past the core's limit", async () => {
    const ask = serve(core().hc);
    for (const path of [join(folder, "missing.txt"), join(folder, "sub"), join(folder, "broken"), "relative.txt", ""]) {
      expect(await error(await ask(`/api/fs/stat?path=${q(path)}`)), path).toEqual([404, "not_found"]);
    }
    expect(await (await ask(`/api/fs/stat?path=${q(join(folder, "big.bin"))}`)).json()).toMatchObject({ size: 8_000_001 });
    expect(await error(await ask(`/api/fs/file?path=${q(join(folder, "big.bin"))}`))).toEqual([413, "file_too_large"]);
  });

  it("puts a pasted image beside the terminal there and answers where it landed", async () => {
    const { hc, puts } = core();
    const ask = serve(hc);
    const answer = await paste(ask, { pane_id: "t3", content_type: "image/png", data_base64: PNG.toString("base64") });
    expect(answer.status).toBe(200);
    const { path } = await answer.json() as { path: string };
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ terminal: "t3", data: PNG.toString("base64") });
    expect(String(puts[0]!["name"])).toMatch(/^paste-\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
    expect(path).toBe(`/home/lab/.local/state/herdr-core/files/t3/${String(puts[0]!["name"])}`);
    // another machine's terminal, and bytes that are no image, are refused before anything is sent
    expect(await error(await paste(ask, { pane_id: "other/t3", content_type: "image/png", data_base64: PNG.toString("base64") }))).toEqual([404, "pane_not_found"]);
    expect(await error(await paste(ask, { pane_id: "t3", content_type: "image/png", data_base64: Buffer.from("no image").toString("base64") }))).toEqual([400, "invalid_image"]);
    // a body larger than an 8 MB image could need is refused while it is read, not after
    expect(await error(await paste(ask, { pane_id: "t3", content_type: "image/png", data_base64: PNG.toString("base64"), name: "x".repeat(12_000_000) }))).toEqual([413, "image_too_large"]);
    expect(puts).toHaveLength(1);
  });

  it("answers hc's refusals in the app's words", async () => {
    const body = { pane_id: "t3", content_type: "image/png", data_base64: PNG.toString("base64") };
    expect(await error(await paste(serve(core(undefined, "not_found").hc), body))).toEqual([404, "pane_not_found"]);
    expect(await error(await paste(serve(core(undefined, "finished").hc), body))).toEqual([409, "pane_finished"]);
    expect(await error(await paste(serve(core(undefined, "machine_unknown").hc), body))).toEqual([503, "machine_unavailable"]);
    const old = serve(core(["machine.list"]).hc);
    expect(await error(await paste(old, body))).toEqual([501, "unsupported"]);
    expect(await error(await old(`/api/fs/stat?path=${q(join(folder, "a.txt"))}`))).toEqual([501, "unsupported"]);
  });

  it("still refuses what is not read there yet: diffs, git, Markdown lists, searches, new folders and edits", async () => {
    const ask = serve(core().hc);
    for (const [path, init] of [
      ["/api/workspace/diff/files?pane_id=t1", {}], ["/api/workspace/git/log?pane_id=t1", {}], ["/api/workspace/pr?pane_id=t1", {}],
      ["/api/pane/files?pane_id=t1", {}], ["/api/pane/docs?pane_id=t1", {}], [`/api/fs/text?pane_id=t1&path=a.txt`, {}],
      ["/api/workspace/directories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder, name: "made" }) }],
    ] as const) {
      expect([path, ...await error(await ask(path, init))]).toEqual([path, 501, "unsupported"]);
    }
  });
});
