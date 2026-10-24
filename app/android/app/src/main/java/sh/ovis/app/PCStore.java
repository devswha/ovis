package sh.ovis.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The PCs this app knows, kept in SharedPreferences, as PCStore in the iOS app keeps them in
 * UserDefaults. The WebView's cookies (a paired device's sign-in) live in its own store.
 */
final class PCStore {
    private static final String PREFS = "herdr";

    /** The address to open instead of the bare origin until a PC page loads: a pairing link keeps its code through Try again. In memory only, as it can hold that code. */
    static String pendingStart;

    /** Why the PC's page failed, for the error page: WebView's reason, or the HTTP status it answered. */
    static volatile String failure;

    /** Redirects in a row that made another origin the PC (MainActivity), so two servers that redirect to each other stop. */
    static volatile int redirects;

    /** Redirects in a row the app follows, in the WebView and in ovisOrigin; past it the error page says so. */
    static final int MAX_REDIRECTS = 5;

    /** How long ovisOrigin waits for each answer. */
    private static final int PROBE_TIMEOUT_MS = 5000;

    /** How long ovisOrigin may take in all, its redirects included: the screen stays blank meanwhile. */
    static final long PROBE_BUDGET_MS = 10000;

    /** More than /api/health ever answers. */
    private static final int PROBE_MAX_BYTES = 64 * 1024;

    /** Ends a probe's request at its deadline: read timeouts alone let a server that trickles go on. */
    private static final ScheduledExecutorService PROBE_DEADLINE = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "ovis-probe-deadline");
        thread.setDaemon(true);
        return thread;
    });

    private PCStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Origins opened before, the latest first. */
    static List<String> saved(Context context) {
        List<String> list = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString("saved", "[]"));
            for (int i = 0; i < array.length(); i++) list.add(array.getString(i));
        } catch (org.json.JSONException ignored) {
            // a damaged list starts empty again
        }
        return list;
    }

    private static void setSaved(Context context, List<String> list) {
        prefs(context).edit().putString("saved", new JSONArray(list).toString()).apply();
    }

    /** The PC the app opens at launch, an origin; null shows the connect screen. */
    static String current(Context context) {
        return prefs(context).getString("current", null);
    }

    static void setCurrent(Context context, String origin) {
        prefs(context).edit().putString("current", origin).apply();
    }

    /** The PC opened last, even after Change PC, for the pages that name it. */
    static String last(Context context) {
        return prefs(context).getString("last", null);
    }

    /** Makes origin the PC to open; it joins the saved PCs only once a page of it loads (remember). */
    static void open(Context context, String origin, String start) {
        prefs(context).edit().putString("current", origin).putString("last", origin).apply();
        pendingStart = start;
    }

    /** Puts origin first in the saved PCs: a page of it has loaded, so an address that never answered is not kept. */
    static void remember(Context context, String origin) {
        List<String> list = saved(context);
        list.remove(origin);
        list.add(0, origin);
        setSaved(context, list);
    }

    static void forget(Context context, String origin) {
        List<String> list = saved(context);
        list.remove(origin);
        setSaved(context, list);
        SharedPreferences.Editor edit = prefs(context).edit();
        if (origin.equals(current(context))) edit.remove("current");
        if (origin.equals(last(context))) edit.remove("last");
        edit.apply();
    }

    /**
     * The origin of the Ovis server that `target` leads to, or null. Asks `/api/health?scope=bridge`,
     * which Ovis answers to anyone so a client can find its gate, and follows at most MAX_REDIRECTS
     * redirects of that request: a sign-in page, another site, a loop or no answer is not Ovis. Only
     * such an origin may become the PC, the one origin that gets Capacitor's bridge. Gives up after
     * about `budgetMs` (PROBE_BUDGET_MS), however slowly the answers come. Blocks: never call it on the
     * main thread.
     */
    static String ovisOrigin(String target, long budgetMs) {
        long deadline = System.nanoTime() + budgetMs * 1_000_000L;
        String next = origin(target);
        for (int hops = 0; next != null && hops <= MAX_REDIRECTS; hops++) {
            long left = (deadline - System.nanoTime()) / 1_000_000L;
            if (left <= 0) return null;
            HttpURLConnection connection = null;
            ScheduledFuture<?> stop = null;
            try {
                URL health = new URL(next + "/api/health?scope=bridge");
                connection = (HttpURLConnection) health.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setConnectTimeout((int) Math.min(PROBE_TIMEOUT_MS, left));
                connection.setReadTimeout((int) Math.min(PROBE_TIMEOUT_MS, left));
                stop = PROBE_DEADLINE.schedule(connection::disconnect, left, TimeUnit.MILLISECONDS);
                connection.setRequestProperty("Accept", "application/json");
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    next = location == null ? null : origin(health.toURI().resolve(location).toString());
                    continue;
                }
                if (status != 200) return null;
                JSONObject answer = new JSONObject(text(connection.getInputStream(), deadline));
                boolean ovis = Boolean.TRUE.equals(answer.opt("ok")) && answer.optJSONObject("auth") != null
                    && answer.opt("bridge_protocol") instanceof Number;
                return ovis ? next : null;
            } catch (IOException | JSONException | URISyntaxException | IllegalArgumentException notOvis) {
                return null;
            } finally {
                if (stop != null) stop.cancel(false);
                if (connection != null) connection.disconnect();
            }
        }
        return null;
    }

    /** `target`'s path, query and fragment on `origin`: a pairing link keeps its code when its server's /api/health redirected to another origin. */
    static String startOn(String origin, String target) {
        try {
            URI uri = new URI(target);
            String path = uri.getRawPath();
            return origin + (path == null || path.isEmpty() ? "/" : path) + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()) + (uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment());
        } catch (URISyntaxException e) {
            return origin + "/";
        }
    }

    private static String text(InputStream stream, long deadline) throws IOException {
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) != -1; ) {
                out.write(buffer, 0, read);
                if (out.size() > PROBE_MAX_BYTES) throw new IOException("answer too long");
                // a body that trickles in ends here too, should the disconnect at the deadline not stop the read at once
                if (System.nanoTime() > deadline) throw new IOException("answer too slow");
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    /** scheme://host[:port] of a well-formed http or https address, the host in lowercase, or null: `http://pc:abc/` is refused, not saved for Capacitor to fail on at the next start. */
    static String origin(String text) {
        URI uri;
        try {
            uri = new URI(text).parseServerAuthority();
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase();
        String host = uri.getHost() == null ? null : uri.getHost().toLowerCase(Locale.ROOT);
        if (scheme == null || !(scheme.equals("http") || scheme.equals("https")) || host == null || host.isEmpty()) return null;
        return uri.getPort() == -1 ? scheme + "://" + host : scheme + "://" + host + ":" + uri.getPort();
    }
}
