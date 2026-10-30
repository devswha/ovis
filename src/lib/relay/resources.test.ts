import { describe, expect, it } from "bun:test";
import { isRelayResourceTarget, relayResourcePath, relayResourceTarget } from "../../../shared/relay-mux.ts";
import { fileUrl, projectFaviconUrl } from "../api.ts";
import { toolGalleryImage, userGalleryImages } from "../chatImages.ts";
import { readerHref } from "../fileReader.ts";
import { relayResourceBlob, RELAY_BLOB_LIMIT, RelayResourceTooLargeError, relayResourceUrl } from "./resources.ts";
import { nativeTransport } from "../transport.ts";

const id = "ab".repeat(16);
const scope = `/s/${id}/`;

describe("resource builders round trip through the per-PC scope", () => {
  for (const machine of ["local", "pc /한%?#"]) it(`preserves every builder's bytes for ${machine}`, () => {
    const t = (text: string) => text;
    const paths = [
      fileUrl("/a &+#/image.png", "p:1", machine),
      fileUrl("/a &+#/image.png", null, machine, true),
      projectFaviconUrl("/a &+#", machine),
      toolGalleryImage(machine, "p:1", { part: { kind: "tool", name: "Read", summary: "", input: "", output: "" },
        ref: "a:0&+#%", mediaType: "image/png", ordinal: 0 }, t).src,
      ...userGalleryImages(machine, "p:1", [{ kind: "image", ref: "b:0&+#%", media_type: "image/png" }], "@/a/image.png", t).map((image) => image.src),
    ];
    expect(paths).toHaveLength(6);
    for (const path of paths) {
      const scoped = relayResourcePath(id, path);
      expect(scoped).toBe(`${scope}~${path}`);
      expect(relayResourceTarget(scope, scoped)).toBe(path);
    }
    const query = "/api/fs/file?path=%2fA%2bB+%20&path=x&&revision=%ff";
    expect(relayResourceTarget(scope, relayResourcePath(id, query))).toBe(query);
  });

  it("refuses mutations and encoded route or scope tricks without normalizing them", () => {
    for (const target of ["/api/devices", "/api/fs/stat", "/api/fs/file/../file", "/api/fs/%66ile",
      "/api//fs/file", "/api/fs/file#x", "/api/machines/../fs/file", "/api/machines/%2e%2E/fs/file", "//api/fs/file", "/api/fs/file\n"]) {
      expect(isRelayResourceTarget(target)).toBe(false);
      expect(() => relayResourcePath(id, target)).toThrow(TypeError);
    }
    for (const path of [`/s/${"cd".repeat(16)}/~/api/fs/file`, `${scope}%7e/api/fs/file`,
      `${scope}~/../~/api/fs/file`, `${scope}~//api/fs/file`]) expect(relayResourceTarget(scope, path)).toBeNull();
  });

  it("makes a stable reader link rather than an active-content blob link", () => {
    expect(readerHref("remote pc", "/a/evil.svg", scope)).toBe(`${scope}?read=%2Fa%2Fevil.svg&machine=remote+pc`);
  });
});

describe("bounded blob resources", () => {
  it("refuses an announced 70 MiB file before pulling any body", async () => {
    let cancelled = false;
    let pulled = false;
    const response = new Response(new ReadableStream({
      pull() { pulled = true; }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { "content-length": String(70 * 1024 * 1024) } });
    await expect(relayResourceBlob(response)).rejects.toBeInstanceOf(RelayResourceTooLargeError);
    expect(cancelled).toBe(true);
    expect(pulled).toBe(false);
  });

  it("caps an unannounced stream and cancels it at the first excess byte", async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(pulls === 1 ? RELAY_BLOB_LIMIT : 1)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    await expect(relayResourceBlob(response)).rejects.toBeInstanceOf(RelayResourceTooLargeError);
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });

  it("keeps the MIME and bytes of an allowed image", async () => {
    const blob = await relayResourceBlob(new Response("image", { headers: { "content-type": "image/svg+xml" } }));
    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toBe("image");
  });

  it("makes downloads inert even if a WebView opens them in place", async () => {
    const transport = { ...nativeTransport, fetch: async () => new Response("<script>bad()</script>", { headers: { "content-type": "text/html" } }) };
    const url = await relayResourceUrl(transport, id, "/api/fs/file?path=a.html&download=1");
    try { expect((await fetch(url)).headers.get("content-type")).toBe("application/octet-stream"); }
    finally { URL.revokeObjectURL(url); }
  });
});
