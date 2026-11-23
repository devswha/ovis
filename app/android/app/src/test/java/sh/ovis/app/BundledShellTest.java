package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import sh.ovis.app.BundledShell.Route;

public class BundledShellTest {
    private static final String ID = "0123456789abcdef0123456789abcdef";

    private static Route get(String path) {
        return BundledShell.route("GET", path);
    }

    @Test
    public void aPcsScopeIsTheShellAsPagesAnswersIt() {
        for (String path : new String[] { "/", "", "/s/" + ID + "/", "/s/" + ID + "/files/deep/page", "/s/" + ID + "/favicon.png" }) {
            assertSame(path, Route.INDEX, get(path));
        }
        // Pages sends /s/<id> to /s/<id>/; an answer here cannot redirect, and the shell reads its PC from either
        assertSame(Route.INDEX, get("/s/" + ID));
    }

    @Test
    public void aPcsRenderHostIsRenderHtmlWithItsOwnPolicyNotTheShell() {
        Route render = get("/s/" + ID + "/~render");
        assertEquals(Route.Kind.FILE, render.kind);
        assertEquals("render.html", render.asset);
        assertEquals("text/html", render.type);
        assertTrue(render.render);
        assertNull("a render host that is missing is never the shell in its place", render.fallback);
        // only that exact address, as Pages' rule takes it
        assertSame(Route.INDEX, get("/s/" + ID + "/~render/"));
        assertFalse(get("/s/" + ID + "/").render);
    }

    @Test
    public void aPcsManifestIsTheShellsAndEveryWorkerRetires() {
        Route manifest = get("/s/" + ID + "/manifest.webmanifest");
        assertEquals("manifest.webmanifest", manifest.asset);
        assertEquals("application/manifest+json", manifest.type);
        assertEquals(404, manifest.fallback.status);
        for (String path : new String[] { "/s/" + ID + "/sw.js", "/sw.js" }) {
            Route worker = get(path);
            assertEquals(Route.Kind.BODY, worker.kind);
            assertEquals(BundledShell.RETIRING_WORKER, worker.body);
            assertEquals("text/javascript", worker.type);
        }
    }

    @Test
    public void aFileIsTheShellsAndAMissingHashedAssetIsA404NotThePage() {
        Route script = get("/assets/index-0123456789.js");
        assertEquals("assets/index-0123456789.js", script.asset);
        assertEquals("text/javascript", script.type);
        assertEquals(Route.Kind.STATUS, script.fallback.kind);
        assertEquals(404, script.fallback.status);
        // anything else missing is the shell, as Pages answers an address it has no file for
        Route other = get("/no-such-page");
        assertEquals("no-such-page", other.asset);
        assertSame(Route.INDEX, other.fallback);
        assertEquals("favicon.png", get("/favicon.png").asset);
        assertEquals("icons/icon 1.png", get("/icons/icon%201.png").asset);
    }

    @Test
    public void anAddressABrowserWouldNotLoadAsWrittenIsRefused() {
        for (String path : new String[] { "/%2e%2e/public/index.html", "/assets/..%2findex.html", "/assets/%2E%2E/x", "/a\\b", "/s/" + ID + "/../x", "/%zz" }) {
            Route route = get(path);
            assertEquals(path, Route.Kind.STATUS, route.kind);
            assertEquals(path, 404, route.status);
        }
    }

    @Test
    public void onlyGetAndHeadAreAnswered() {
        assertEquals(405, BundledShell.route("POST", "/").status);
        assertEquals(405, BundledShell.route("OPTIONS", "/s/" + ID + "/").status);
        assertSame(Route.INDEX, BundledShell.route("HEAD", "/"));
    }

    @Test
    public void capacitorsOwnPathsStayCapacitors() {
        assertSame(Route.CAPACITOR, get("/_capacitor_file_/data/user/0/x"));
        assertSame(Route.CAPACITOR, get("/_capacitor_content_/x"));
    }

    @Test
    public void theBootPageAndItsScriptAreTheAppsOwnOutsideEveryScope() {
        Route page = get(BundledShell.BOOT_PATH);
        assertEquals(Route.Kind.BODY, page.kind);
        assertEquals(BundledShell.BOOT_HTML, page.body);
        assertEquals("text/html", page.type);
        assertTrue(page.body.contains("<script src=\"/_ovis/boot.js\"></script>"));
        Route script = get(BundledShell.BOOT_PATH + ".js");
        assertEquals(BundledShell.BOOT_JS, script.body);
        assertEquals("text/javascript", script.type);
        assertFalse(BundledShell.BOOT_PATH.startsWith("/s/"));
    }

    @Test
    public void typesAreByExtension() {
        assertEquals("text/javascript", BundledShell.type("assets/a.mjs"));
        assertEquals("text/css", BundledShell.type("assets/a.css"));
        assertEquals("application/wasm", BundledShell.type("assets/ghostty-vt.wasm"));
        assertEquals("font/woff2", BundledShell.type("assets/PretendardVariable.subset.0.WOFF2"));
        assertEquals("image/svg+xml", BundledShell.type("store-badges/app-store-en.svg"));
        assertEquals("application/json", BundledShell.type("build.json"));
        assertEquals("text/markdown", BundledShell.type("THIRD_PARTY_NOTICES.md"));
        assertEquals("application/octet-stream", BundledShell.type("no-such-page"));
        assertEquals("application/octet-stream", BundledShell.type("a.b/c"));
    }

    @Test
    public void theContractNamesThisAppsVersion() {
        assertEquals(
            "window.__ovisAppShell = Object.freeze({ bundled: true, platform: \"android\", appVersion: \"1.0.7\", build: 15 });",
            BundledShell.contractScript("1.0.7", 15)
        );
        // a version name is data, never script
        assertTrue(BundledShell.contractScript("1\"); alert(1); (\"", 1).contains("appVersion: \"1\\\"); alert(1); (\\\"\""));
    }

    @Test
    public void theBootPageCarriesItsNextAddressInItsFragmentAsTheScriptReadsItBack() throws Exception {
        String start = "/s/" + ID + "/#offer=a+b/c%20d&é";
        String boot = BundledShell.bootStart(start);
        assertTrue(boot.startsWith(BundledShell.BOOT_PATH + "#"));
        String fragment = boot.substring(boot.indexOf('#') + 1);
        assertTrue("only unreserved characters stay as they are", fragment.matches("[A-Za-z0-9._~%-]*"));
        assertEquals(start, URLDecoder.decode(fragment, StandardCharsets.UTF_8.name()));
        assertEquals(BundledShell.BOOT_PATH + "#%2F%23pcs", BundledShell.bootStart("/#pcs"));
    }

    @Test
    public void theBootPageIsThatAddressOnTheHostedOriginAlone() {
        String app = "https://app.ovis.sh";
        assertTrue(BundledShell.isBoot("https://app.ovis.sh/_ovis/boot#%2F", app));
        assertTrue(BundledShell.isBoot("https://app.ovis.sh:443/_ovis/boot", app));
        assertFalse(BundledShell.isBoot("https://app.ovis.sh/_ovis/boot.js", app));
        assertFalse(BundledShell.isBoot("https://app.ovis.sh/s/" + ID + "/_ovis/boot", app));
        assertFalse(BundledShell.isBoot("https://localhost/_ovis/boot", app));
        assertFalse(BundledShell.isBoot(null, app));
    }
}
