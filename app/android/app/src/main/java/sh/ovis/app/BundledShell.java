package sh.ovis.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The hosted shell this build carries (BuildConfig.SHELL_BUNDLED; docs/native-app.md, "The bundled shell"), answered
 * at the hosted origin itself (BuildConfig.APP_ORIGIN), with no network: a person who updates from a build that loaded
 * the shell from there keeps that origin's storage, its sign-in, keys and pairings among it.
 *
 * <p>Only where the WebView's requests to that origin are answered changes. The activity opens it as it always did
 * (server.url, the bridge's origin rules, error.html on the app's own origin), so every plugin's and page's gate that
 * keys on them decides as in a build that loads the shell from the network. This class does what Pages' `_redirects`
 * and `_headers` do for app.ovis.sh (scripts/shell-build.ts): a PC's scope is the shell, its render host
 * render.html, the shell's policies on every answer. Two answers are the app's own: a worker script that retires any
 * worker the network's copy registered (`sw.js`), and the boot page that clears them before the first page of a
 * bundled start runs (`BOOT_PATH`, needsBoot).
 */
final class BundledShell {
    /** Where the shell is in the app's assets (app/scripts/bundled-shell.ts SHELL_ASSETS). */
    static final String DIR = "shell";
    static final String POLICY = "shell-policy.json";

    /** The page a bundled start opens first while a worker of the network's copy may be left (needsBoot): outside every PC's scope, which no worker controls. */
    static final String BOOT_PATH = "/_ovis/boot";

    /** The cache the client keeps its fonts in (src/lib/userFonts.ts): kept, as no worker serves from it. */
    static final String FILES_CACHE = "ovis-files-v1";

    private static final Pattern SCOPE_FILE = Pattern.compile("/s/[^/]+/(manifest\\.webmanifest|sw\\.js|~render)");

    static final String BOOT_HTML =
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Ovis</title>" +
        "<script src=\"" + BOOT_PATH + ".js\"></script></head><body></body></html>\n";

    /**
     * Unregisters every worker on the origin and deletes the caches they served from, then goes on, in place of this
     * page, to the address its fragment names (on this origin only). `OvisBoot` hears that it was done, so the next start
     * goes straight to its page; a clean-up that fails or takes over three seconds goes on all the same, and the next
     * start tries again.
     */
    static final String BOOT_JS =
        "(() => {\n" +
        "  let target = \"/\";\n" +
        "  try {\n" +
        "    const asked = new URL(decodeURIComponent(location.hash.slice(1)), location.origin);\n" +
        "    if (asked.origin === location.origin) target = asked.pathname + asked.search + asked.hash;\n" +
        "  } catch {}\n" +
        "  const clean = async () => {\n" +
        "    const workers = \"serviceWorker\" in navigator ? await navigator.serviceWorker.getRegistrations() : [];\n" +
        "    if ((await Promise.all(workers.map((worker) => worker.unregister()))).includes(false)) return false;\n" +
        "    if (typeof caches !== \"undefined\") for (const name of await caches.keys()) if (name !== \"" + FILES_CACHE + "\") await caches.delete(name);\n" +
        "    return true;\n" +
        "  };\n" +
        "  const late = new Promise((done) => setTimeout(() => done(false), 3000));\n" +
        "  Promise.race([clean(), late]).catch(() => false).then((cleaned) => {\n" +
        "    if (cleaned === true && window.OvisBoot) OvisBoot.postMessage(\"cleaned\");\n" +
        "    location.replace(target);\n" +
        "  });\n" +
        "})();\n";

    /**
     * What every `sw.js` on the origin answers (the shell registers none in this app: window.__ovisAppShell): a worker
     * that, once the browser checks a worker the network's copy registered for an update, takes its place and removes
     * itself with its caches, with no fetch handler meanwhile. So a worker the boot page missed, or one that copy
     * registers again while it runs once, goes on its next check instead of serving that copy for 24 hours.
     */
    static final String RETIRING_WORKER =
        "// The Ovis app carries its own shell: a worker registered here retires\n" +
        "self.addEventListener(\"install\", () => self.skipWaiting());\n" +
        "self.addEventListener(\"activate\", (event) => event.waitUntil(self.registration.unregister()\n" +
        "  .then(() => caches.keys())\n" +
        "  .then((names) => Promise.all(names.filter((name) => name !== \"" + FILES_CACHE + "\").map((name) => caches.delete(name))))));\n";

    /** How a request is answered. */
    static final class Route {
        enum Kind {
            /** An asset of the shell (`asset`), else `fallback`. */
            FILE,
            /** `body`, written here. */
            BODY,
            /** Capacitor's own paths (`/_capacitor_file_/` and the like), which its local server answers as it does with the shell from the network. */
            CAPACITOR,
            /** No body. */
            STATUS
        }

        final Kind kind;
        final int status;
        final String asset;
        final Route fallback;
        final String body;
        final String type;
        /** The render host's policy (Pages' `/s/:id/~render` block) rather than the shell's. */
        final boolean render;

        private Route(Kind kind, int status, String asset, Route fallback, String body, String type, boolean render) {
            this.kind = kind;
            this.status = status;
            this.asset = asset;
            this.fallback = fallback;
            this.body = body;
            this.type = type;
            this.render = render;
        }

        static Route file(String asset, Route fallback) {
            return new Route(Kind.FILE, 200, asset, fallback, null, type(asset), false);
        }

        static Route body(String body, String type) {
            return new Route(Kind.BODY, 200, null, null, body, type, false);
        }

        static Route status(int status) {
            return new Route(Kind.STATUS, status, null, null, null, "text/plain", false);
        }

        static final Route CAPACITOR = new Route(Kind.CAPACITOR, 0, null, null, null, null, false);
        static final Route INDEX = file("index.html", null);
        static final Route RENDER = new Route(Kind.FILE, 200, "render.html", null, null, "text/html", true);
        static final Route WORKER = body(RETIRING_WORKER, "text/javascript");
    }

    /**
     * How the shell's host answers `method` for `path` (as the request carries it, percent-encoded), as Pages answers
     * app.ovis.sh (scripts/shell-build.ts shellRedirects): a PC's manifest, worker and render host under its scope, the
     * shell for anything else there, a file of the shell where there is one, a 404 for a hashed asset there is not,
     * and the shell for any other address. Two exceptions: Pages sends `/s/<id>` to `/s/<id>/` (an answer here cannot
     * redirect, so it is the shell there too, which reads its PC from either), and every `sw.js` retires
     * (RETIRING_WORKER). Nothing but GET and HEAD: the shell's host takes no other.
     */
    static Route route(String method, String path) {
        if (!"GET".equals(method) && !"HEAD".equals(method)) return Route.status(405);
        if (path == null || path.isEmpty()) path = "/";
        if (path.startsWith("/_capacitor_")) return Route.CAPACITOR;
        if (PCStore.cleanPath(path) == null || !path.startsWith("/")) return Route.status(404);
        if (path.equals(BOOT_PATH)) return Route.body(BOOT_HTML, "text/html");
        if (path.equals(BOOT_PATH + ".js")) return Route.body(BOOT_JS, "text/javascript");
        Matcher scoped = SCOPE_FILE.matcher(path);
        if (scoped.matches()) {
            String file = scoped.group(1);
            if (file.equals("sw.js")) return Route.WORKER;
            if (file.equals("~render")) return Route.RENDER;
            return Route.file("manifest.webmanifest", Route.status(404));
        }
        if (path.equals("/sw.js")) return Route.WORKER;
        if (path.startsWith("/s/") || path.equals("/")) return Route.INDEX;
        String asset = PCStore.percentDecoded(path.substring(1));
        if (asset == null || asset.isEmpty()) return Route.status(404);
        return Route.file(asset, path.startsWith("/assets/") ? Route.status(404) : Route.INDEX);
    }

    /** The Content-Type of the shell's file `name`, by its extension, as Pages names them. */
    static String type(String name) {
        int dot = name.lastIndexOf('.');
        String extension = dot < 0 || name.lastIndexOf('/') > dot ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (extension) {
            case "html": return "text/html";
            case "js":
            case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json":
            case "map": return "application/json";
            case "webmanifest": return "application/manifest+json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            case "ico": return "image/x-icon";
            case "woff2": return "font/woff2";
            case "woff": return "font/woff";
            case "ttf": return "font/ttf";
            case "wasm": return "application/wasm";
            case "md": return "text/markdown";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    private static boolean text(String type) {
        return type.startsWith("text/") || type.endsWith("json") || type.equals("image/svg+xml");
    }

    /**
     * The script every page of the bundled shell (and the app's own pages) gets at document start, before its own:
     * the contract the client reads (`window.__ovisAppShell`) to know it is the app's copy, with the app's version.
     */
    static String contractScript(String versionName, int versionCode) {
        return "window.__ovisAppShell = Object.freeze({ bundled: true, platform: \"android\", appVersion: " + JSONObject.quote(versionName) + ", build: " + versionCode + " });";
    }

    /** The boot page's address that goes on to `start` (a path on the origin, with its query and fragment). */
    static String bootStart(String start) {
        return BOOT_PATH + "#" + encoded(start == null ? "/" : start);
    }

    /** Whether `url` is the boot page on `appOrigin`. */
    static boolean isBoot(String url, String appOrigin) {
        if (url == null || !PCStore.sameOrigin(url, appOrigin)) return false;
        try {
            return BOOT_PATH.equals(new java.net.URI(url).getRawPath());
        } catch (java.net.URISyntaxException notAnAddress) {
            return false;
        }
    }

    /** `text` with everything but an unreserved character percent-encoded (UTF-8), as decodeURIComponent reads it back. */
    static String encoded(String text) {
        StringBuilder out = new StringBuilder();
        for (byte b : text.getBytes(StandardCharsets.UTF_8)) {
            char c = (char) (b & 0xff);
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~') out.append(c);
            else out.append(String.format(Locale.ROOT, "%%%02X", b & 0xff));
        }
        return out.toString();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("ovis-bundled-shell", Context.MODE_PRIVATE);
    }

    /**
     * Whether a bundled start opens the boot page first: until a boot page cleared the origin's workers, and again
     * after the shell was loaded from the network (loadedFromNetwork), whose copy registers them.
     */
    static boolean needsBoot(Context context) {
        return !prefs(context).getBoolean("workers-cleared", false);
    }

    static void booted(Context context) {
        prefs(context).edit().putBoolean("workers-cleared", true).apply();
    }

    /** The shell came from the network at the hosted origin (a WebView without what serving it needs, `at`): its copy may register workers again. */
    static void loadedFromNetwork(Context context) {
        if (!needsBoot(context)) prefs(context).edit().putBoolean("workers-cleared", false).apply();
    }

    private final Context context;
    private final String appOrigin;
    private final String pagePolicy;
    private final String renderPolicy;

    private BundledShell(Context context, String appOrigin, String pagePolicy, String renderPolicy) {
        this.context = context.getApplicationContext();
        this.appOrigin = appOrigin;
        this.pagePolicy = pagePolicy;
        this.renderPolicy = renderPolicy;
    }

    /**
     * The shell this build carries, answered at `appOrigin`, or null where it cannot be: a build that carries none, or a
     * WebView without document-start scripts and message listeners, which the contract, Capacitor's bridge and the boot
     * page need on a page this app answers itself (such a WebView loads the shell from the network, as before).
     */
    static BundledShell at(Context context, String appOrigin) {
        if (!supported()) return null;
        try (InputStream index = context.getAssets().open(DIR + "/index.html"); InputStream policy = context.getAssets().open(POLICY)) {
            JSONObject policies = new JSONObject(new String(readAll(policy), StandardCharsets.UTF_8));
            String page = policies.getString("page"), render = policies.getString("render");
            if (page.isEmpty() || render.isEmpty()) return null;
            return new BundledShell(context, appOrigin, page, render);
        } catch (IOException | JSONException none) {
            return null;
        }
    }

    /** Whether this WebView can take a page the app answers itself as the shell needs it: document-start scripts and message listeners. */
    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
        return out.toByteArray();
    }

    /**
     * What the WebView, or a worker's fetch, gets for `request`: the shell's answer for its origin (route), with the
     * shell's policies; anything else, and Capacitor's own paths there, from `local` as before, where a request to the
     * shell's origin that `local` does not answer gets a 404 rather than the network.
     */
    WebResourceResponse serve(WebResourceRequest request, Supplier<WebResourceResponse> local) {
        String url = request.getUrl().toString();
        if (!PCStore.sameOrigin(url, appOrigin)) return local.get();
        Route route = route(request.getMethod(), request.getUrl().getEncodedPath());
        if (route.kind == Route.Kind.CAPACITOR) {
            WebResourceResponse answer = local.get();
            return answer != null ? answer : answer(Route.status(404), false);
        }
        return answer(route, "HEAD".equals(request.getMethod()));
    }

    private WebResourceResponse answer(Route route, boolean head) {
        InputStream body;
        if (route.kind == Route.Kind.FILE) {
            try {
                body = context.getAssets().open(DIR + "/" + route.asset);
            } catch (IOException missing) {
                return route.fallback == null ? answer(Route.status(404), head) : answer(route.fallback, head);
            }
        } else if (route.kind == Route.Kind.BODY) {
            body = new ByteArrayInputStream(route.body.getBytes(StandardCharsets.UTF_8));
        } else {
            body = new ByteArrayInputStream(new byte[0]);
        }
        if (head) {
            try {
                body.close();
            } catch (IOException ignored) {
            }
            body = new ByteArrayInputStream(new byte[0]);
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", route.render ? renderPolicy : pagePolicy);
        headers.put("Cache-Control", "no-cache");
        String reason = route.status == 200 ? "OK" : route.status == 404 ? "Not Found" : "Method Not Allowed";
        return new WebResourceResponse(route.type, text(route.type) ? "utf-8" : null, route.status, reason, headers, body);
    }
}
