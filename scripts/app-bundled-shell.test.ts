import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { appShell, carried, packShell, SHELL_ASSETS, shellPoliciesOf } from "../app/scripts/bundled-shell.ts";
import { writeNativeOrigin } from "../app/scripts/hosted-origin.ts";
import { RENDER_PATH, SHELL_META, shellHeaders, shellPolicies } from "./shell-build.ts";

const app = join(import.meta.dir, "../app");
const java = readFileSync(join(app, "android/app/src/main/java/sh/ovis/app/BundledShell.java"), "utf8");
const gradle = readFileSync(join(app, "android/app/build.gradle"), "utf8");

/** A `static final String` of BundledShell.java as Java reads it: its literals and the constants before it, joined. */
function javaString(name: string, known: Record<string, string> = {}): string {
  const start = java.indexOf(`static final String ${name} =`);
  if (start < 0) throw new Error(`BundledShell.java declares no ${name}`);
  let at = java.indexOf("=", start) + 1;
  let value = "";
  for (;;) {
    while (/\s|\+/.test(java[at]!)) at++;
    if (java[at] === ";") return value;
    if (java[at] === '"') {
      let end = at + 1;
      while (java[end] !== '"') end += java[end] === "\\" ? 2 : 1;
      value += JSON.parse(java.slice(at, end + 1));
      at = end + 1;
      continue;
    }
    const identifier = /^[A-Z_]+/.exec(java.slice(at))?.[0];
    if (!identifier || !(identifier in known)) throw new Error(`${name} joins something this test does not know at: ${java.slice(at, at + 40)}`);
    value += known[identifier];
    at += identifier.length;
  }
}

const BOOT_PATH = javaString("BOOT_PATH");
const FILES_CACHE = javaString("FILES_CACHE");
const BOOT_JS = javaString("BOOT_JS", { BOOT_PATH, FILES_CACHE });
const RETIRING_WORKER = javaString("RETIRING_WORKER", { FILES_CACHE });

describe("where the Android app takes the shell from", () => {
  it("carries it for the production origin and loads it from the network for a preview's, unless told", () => {
    expect(appShell(undefined, null)).toBe("bundled");
    expect(appShell("", null)).toBe("bundled");
    expect(appShell(undefined, "https://relay-0510.ovis-app.pages.dev")).toBe("hosted");
    expect(appShell("bundled", "https://relay-0510.ovis-app.pages.dev")).toBe("bundled");
    expect(appShell("hosted", null)).toBe("hosted");
    for (const text of ["Bundled", "network", "1"]) expect(() => appShell(text, null)).toThrow("OVIS_APP_SHELL must be bundled or hosted");
  });

  it("is written for Android alone, and only when it is hosted", () => {
    const dir = mkdtempSync(join(tmpdir(), "app-shell-origin-"));
    try {
      mkdirSync(join(dir, "android/app"), { recursive: true });
      mkdirSync(join(dir, "ios"), { recursive: true });
      const android = join(dir, "android/app/hosted-origin.properties");
      const ios = join(dir, "ios/hosted-origin.generated.xcconfig");
      writeNativeOrigin(dir, null, "hosted", "hosted");
      expect(readFileSync(android, "utf8")).toBe("appShell=hosted\n");
      expect(existsSync(ios)).toBe(false);
      writeNativeOrigin(dir, "https://relay-0510.ovis-app.pages.dev", "bundled", "hosted");
      expect(readFileSync(android, "utf8")).toBe("appOrigin=https://relay-0510.ovis-app.pages.dev\nappHome=bundled\nappShell=hosted\n");
      expect(readFileSync(ios, "utf8")).toBe("OVIS_APP_ORIGIN = https:/$()/relay-0510.ovis-app.pages.dev\nOVIS_APP_HOME = bundled\n");
      writeNativeOrigin(dir, null, "hosted", "bundled");
      expect(existsSync(android)).toBe(false);
      expect(existsSync(ios)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is what the Android build reads, carried by default, and a hosted shell is never the store app", () => {
    expect(gradle).toContain('getProperty("appShell", "bundled") != "hosted"');
    expect(gradle).toContain('buildConfigField "boolean", "SHELL_BUNDLED", "${shellBundled}"');
    expect(gradle).toContain(`main.assets.srcDirs += ['${basename(SHELL_ASSETS)}']`);
    expect(dirname(SHELL_ASSETS)).toBe("android/app");
    expect(gradle).toContain("task.name ==~ /(assemble|bundle|install|package|sign)Release(Bundle)?/");
    expect(gradle).toContain('android.defaultConfig.applicationId == "sh.ovis.app"');
  });
});

describe("the shell's policies in the app", () => {
  it("are read back from the copy's _headers as shell-build.ts writes them, so the two cannot drift", () => {
    expect(shellPoliciesOf(shellHeaders())).toEqual(shellPolicies());
    expect(shellPolicies().render).toContain("sandbox allow-scripts");
    expect(shellPolicies().page).not.toBe(shellPolicies().render);
  });

  it("refuse a _headers without them in their places", () => {
    const headers = shellHeaders();
    expect(() => shellPoliciesOf(headers.replace(/^\/\*$/m, "/elsewhere"))).toThrow("no one Content-Security-Policy for /*");
    expect(() => shellPoliciesOf(headers.replace("  ! Content-Security-Policy\n", ""))).toThrow(`gives ${RENDER_PATH} no policy of its own`);
    expect(() => shellPoliciesOf("")).toThrow();
  });
});

describe("packing a dist-shell into the app", () => {
  function distShell(): string {
    const from = mkdtempSync(join(tmpdir(), "app-shell-dist-"));
    const files: Record<string, string> = {
      "index.html": `<!doctype html><html><head>\n    ${SHELL_META}\n</head></html>`,
      "render.html": "<!doctype html>",
      "manifest.webmanifest": "{}",
      "sw.js": "// worker",
      "build.json": "{}",
      "_headers": shellHeaders(),
      "_redirects": "/s/* /index.html 200\n",
      "assets/index-0123456789.js": "export {};",
      "assets/index-0123456789.js.gz": "gz",
      "assets/index-0123456789.css.br": "br",
      ".well-known/assetlinks.json": "[]",
      "icons/icon-192.png": "png",
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(from, name)), { recursive: true });
      writeFileSync(join(from, name), content);
    }
    return from;
  }

  it("carries what the app serves, leaves the web host's own files and the precompressed copies, and writes the policies beside it", () => {
    const from = distShell();
    const assets = mkdtempSync(join(tmpdir(), "app-shell-assets-"));
    try {
      const packed = packShell(from, assets);
      const shell = readdirSync(join(assets, "shell"), { recursive: true, encoding: "utf8" }).filter((file) => statSync(join(assets, "shell", file)).isFile()).map((file) => file.split(sep).join("/")).sort();
      expect(shell).toEqual(["assets/index-0123456789.js", "build.json", "icons/icon-192.png", "index.html", "manifest.webmanifest", "render.html", "sw.js"]);
      expect(packed.files).toBe(7);
      expect(JSON.parse(readFileSync(join(assets, "shell-policy.json"), "utf8"))).toEqual(shellPolicies());
      // the folder BundledShell.java reads (DIR, POLICY)
      expect(javaString("DIR")).toBe("shell");
      expect(javaString("POLICY")).toBe("shell-policy.json");
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(assets, { recursive: true, force: true });
    }
  });

  it("leaves out sidecars and Pages' files by name", () => {
    for (const path of ["a.js.gz", "assets/b.css.br", "_headers", "_redirects", ".well-known", ".well-known/assetlinks.json"]) expect(carried(path)).toBe(false);
    for (const path of ["index.html", "assets/a.js", "assets/_headers.js", "s/_redirects", "well-known.txt"]) expect(carried(path)).toBe(true);
  });

  it("fails loudly, carrying nothing, over its size budget or for anything but a dist-shell", () => {
    const from = distShell();
    const assets = join(mkdtempSync(join(tmpdir(), "app-shell-assets-")), "bundled-shell");
    try {
      expect(() => packShell(from, assets, 64)).toThrow(/over its 0 MB budget \(SHELL_BUDGET_BYTES; it was 31 MB on 2026-11-24\)\. Largest: /);
      expect(existsSync(assets)).toBe(false);
      writeFileSync(join(from, "index.html"), "<!doctype html><html><head></head></html>");
      expect(() => packShell(from, assets)).toThrow(`is not the shell's: it lacks ${SHELL_META}`);
      rmSync(join(from, "_headers"));
      expect(() => packShell(from, assets)).toThrow("is not a dist-shell: it holds no _headers");
      expect(existsSync(assets)).toBe(false);
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(dirname(assets), { recursive: true, force: true });
    }
  });
});

describe("the bundled shell's boot page", () => {
  async function boot(hash: string, { workers = [true, true], names = ["ovis-v4-sheep-abc", FILES_CACHE], hang = false, fail = false } = {}) {
    const replaced: string[] = [];
    const posted: string[] = [];
    const deleted: string[] = [];
    const unregistered: number[] = [];
    const location = { hash, origin: "https://app.ovis.sh", replace: (to: string) => replaced.push(to) };
    const navigator = {
      serviceWorker: {
        getRegistrations: () => hang ? new Promise(() => {}) : fail ? Promise.reject(new Error("no")) : Promise.resolve(workers.map((result, index) => ({ unregister: async () => { unregistered.push(index); return result; } }))),
      },
    };
    const caches = { keys: async () => names, delete: async (name: string) => { deleted.push(name); return true; } };
    const OvisBoot = { postMessage: (message: string) => posted.push(message) };
    // the three seconds pass at once for a clean-up that hangs, and never otherwise
    const timer = (done: () => void) => { if (hang) done(); };
    new Function("location", "navigator", "caches", "window", "OvisBoot", "setTimeout", BOOT_JS)(location, navigator, caches, { OvisBoot }, OvisBoot, timer);
    for (let turn = 0; turn < 50 && replaced.length === 0; turn++) await Promise.resolve();
    return { replaced, posted, deleted, unregistered };
  }

  const encoded = (text: string) => encodeURIComponent(text);

  it("unregisters every worker, deletes the caches they served from, says so, then goes on in its own place", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const run = await boot(`#${encoded(`/s/${id}/#offer=x`)}`);
    expect(run.unregistered).toEqual([0, 1]);
    expect(run.deleted).toEqual(["ovis-v4-sheep-abc"]);
    expect(run.posted).toEqual(["cleaned"]);
    expect(run.replaced).toEqual([`/s/${id}/#offer=x`]);
    expect((await boot(`#${encoded("/#pcs")}`)).replaced).toEqual(["/#pcs"]);
    expect((await boot("")).replaced).toEqual(["/"]);
  });

  it("goes on to its own origin alone", async () => {
    for (const target of ["https://evil.example/", "//evil.example/x", "/\\evil.example/", "javascript:alert(1)", "http://app.ovis.sh/"]) {
      expect((await boot(`#${encoded(target)}`)).replaced).toEqual(["/"]);
    }
    expect((await boot("#%E0%A4%A")).replaced).toEqual(["/"]);
  });

  it("goes on without saying it cleaned when a worker stays, the clean-up fails or it takes too long", async () => {
    const stayed = await boot("#%2F", { workers: [true, false] });
    expect(stayed.posted).toEqual([]);
    expect(stayed.deleted).toEqual([]);
    expect(stayed.replaced).toEqual(["/"]);
    for (const run of [await boot("#%2F", { fail: true }), await boot("#%2F", { hang: true })]) {
      expect(run.posted).toEqual([]);
      expect(run.replaced).toEqual(["/"]);
    }
  });

  it("lies outside every PC's scope, which a worker of the network's copy controls", () => {
    expect(BOOT_PATH).toBe("/_ovis/boot");
    expect(BOOT_PATH.startsWith("/s/")).toBe(false);
  });

  it("keeps the client's own cache, the one no worker serves from", () => {
    expect(readFileSync(join(import.meta.dir, "../src/lib/userFonts.ts"), "utf8")).toContain(`const CACHE = "${FILES_CACHE}";`);
    expect(readFileSync(join(import.meta.dir, "../public/sw.js"), "utf8")).toContain(`const FILES = "${FILES_CACHE}";`);
  });
});

describe("the worker every sw.js answers in the app", () => {
  it("takes the old worker's place at once and removes itself and its caches, serving nothing meanwhile", async () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const skipWaiting = mock(() => Promise.resolve());
    const unregister = mock(() => Promise.resolve(true));
    const deleted: string[] = [];
    const self = { addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; }, skipWaiting, registration: { unregister } };
    const caches = { keys: async () => ["ovis-v4-sheep-abc", FILES_CACHE, "ovis-v3"], delete: async (name: string) => { deleted.push(name); return true; } };
    new Function("self", "caches", RETIRING_WORKER)(self, caches);
    expect(Object.keys(listeners).sort()).toEqual(["activate", "install"]);
    listeners["install"]!({});
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    let done: Promise<unknown> = Promise.resolve();
    listeners["activate"]!({ waitUntil: (work: Promise<unknown>) => { done = work; } });
    await done;
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(["ovis-v4-sheep-abc", "ovis-v3"]);
  });
});
