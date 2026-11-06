package sh.ovis.app;

import android.net.Uri;
import android.util.Base64;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The PC's direct carriers for the hosted shell (src/lib/relay/directSocket.ts; docs/relay.md, "Direct on
 * the same network"): a page on https cannot open plain `ws://`. Only the app's own origin may call it
 * (allowed), only `ws://<private IPv4>:<port>/v1/ws?v=1` opens (DirectSocket.carrier), at most two at once.
 * Frames go to the page in order as `{ id, kind, data }` (binary as base64); a socket whose messages the page
 * has not acknowledged pass 4 MiB or 16,384 is closed with 1009. Noise inside the channel proves the PC: the
 * address is only a hint. The iOS twin: app/ios/App/App/OvisDirectPlugin.swift.
 */
@CapacitorPlugin(name = "OvisDirect")
public class OvisDirectPlugin extends Plugin {
    static final String APP_ORIGIN = "https://app.ovis.sh";
    static final int MAX_SOCKETS = 2;
    static final int MAX_QUEUED_BYTES = 4 * 1024 * 1024;
    static final int MAX_QUEUED_MESSAGES = 16_384;

    private static final class Entry {
        DirectSocket socket;
        /** sizes of the messages sent to the page and not acknowledged yet, oldest first */
        final ArrayDeque<Integer> unacked = new ArrayDeque<>();
        long unackedBytes;
    }

    private final Map<String, Entry> sockets = new HashMap<>();

    @Override
    public void load() {
        // a new page: the old one's sockets would hold both places and nobody reads them
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                closeAll();
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        closeAll();
    }

    /**
     * Whether the page calling is the app's own: Capacitor's bridge reaches only its origin rule's pages and
     * only their main frame (MessageHandler), and that rule is the hosted shell's origin only while a relay PC
     * is open. Without the WebView's message listener Capacitor falls back to an interface every frame and
     * origin can call: refused then.
     */
    private boolean allowed(PluginCall call) {
        boolean bridged = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && !bridge.getConfig().isUsingLegacyBridge();
        if (!bridged || !APP_ORIGIN.equals(bridge.getServerUrl())) {
            call.reject("OvisDirect answers only the app's own page", "not_allowed");
            return false;
        }
        return true;
    }

    @PluginMethod
    public void open(PluginCall call) {
        if (!allowed(call)) return;
        String[] carrier = DirectSocket.carrier(call.getString("url"));
        if (carrier == null) {
            call.reject("Only a direct carrier on a private address opens", "invalid_url");
            return;
        }
        // the page on screen, checked where the WebView lives: the bundled error page shares the bridge
        getActivity().runOnUiThread(() -> {
            String page = bridge.getWebView().getUrl();
            Uri url = page == null ? null : Uri.parse(page);
            if (url == null || !"https".equals(url.getScheme()) || !"app.ovis.sh".equals(url.getHost()) || (url.getPort() != -1 && url.getPort() != 443)) {
                call.reject("OvisDirect answers only the app's own page", "not_allowed");
                return;
            }
            String id = UUID.randomUUID().toString();
            Entry entry = new Entry();
            synchronized (this) {
                if (sockets.size() >= MAX_SOCKETS) {
                    call.reject("Two direct sockets are open already", "too_many");
                    return;
                }
                sockets.put(id, entry);
                entry.socket = new DirectSocket(carrier[0], Integer.parseInt(carrier[1]), listener(id));
            }
            JSObject result = new JSObject();
            result.put("id", id);
            // answered before the socket starts, so the page knows it before any of its events
            call.resolve(result);
            entry.socket.start();
        });
    }

    private DirectSocket.Listener listener(String id) {
        return new DirectSocket.Listener() {
            @Override
            public void onText(String text) {
                deliver(id, "text", text, text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
            }

            @Override
            public void onBinary(byte[] bytes) {
                deliver(id, "binary", Base64.encodeToString(bytes, Base64.NO_WRAP), bytes.length);
            }

            @Override
            public void onClose(int code, String reason, boolean failed) {
                synchronized (OvisDirectPlugin.this) {
                    if (sockets.remove(id) == null) return;
                    JSObject event = new JSObject();
                    event.put("id", id);
                    if (failed) notifyListeners("error", event);
                    JSObject closed = new JSObject();
                    closed.put("id", id);
                    closed.put("code", code);
                    closed.put("reason", reason);
                    notifyListeners("close", closed);
                }
            }
        };
    }

    /** One message to the page, unless the page is that far behind: then the socket ends with 1009. */
    private synchronized void deliver(String id, String kind, String data, int size) {
        Entry entry = sockets.get(id);
        if (entry == null) return;
        if (entry.unacked.size() + 1 > MAX_QUEUED_MESSAGES || entry.unackedBytes + size > MAX_QUEUED_BYTES) {
            entry.socket.close(1009, "receive queue full");
            sockets.remove(id);
            JSObject closed = new JSObject();
            closed.put("id", id);
            closed.put("code", 1009);
            closed.put("reason", "receive queue full");
            notifyListeners("close", closed);
            return;
        }
        entry.unacked.add(size);
        entry.unackedBytes += size;
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("kind", kind);
        event.put("data", data);
        notifyListeners("message", event);
    }

    @PluginMethod
    public void send(PluginCall call) {
        if (!allowed(call)) return;
        String id = call.getString("id");
        String kind = call.getString("kind");
        String data = call.getString("data");
        Entry entry;
        synchronized (this) { entry = id == null ? null : sockets.get(id); }
        if (entry == null || data == null) {
            call.reject("That socket is closed", "closed");
            return;
        }
        if ("text".equals(kind)) {
            entry.socket.sendText(data);
        } else if ("binary".equals(kind)) {
            byte[] bytes;
            try { bytes = Base64.decode(data, Base64.DEFAULT); } catch (IllegalArgumentException error) { call.reject("Binary data is base64", "invalid_frame"); return; }
            entry.socket.sendBinary(bytes);
        } else {
            call.reject("A frame is text or binary", "invalid_frame");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        if (!allowed(call)) return;
        String id = call.getString("id");
        Entry entry;
        synchronized (this) { entry = id == null ? null : sockets.get(id); }
        if (entry != null) {
            Integer code = call.getInt("code");
            String reason = call.getString("reason");
            entry.socket.close(code == null ? 1000 : code, reason == null ? "" : reason);
        }
        call.resolve();
    }

    @PluginMethod
    public void ack(PluginCall call) {
        if (!allowed(call)) return;
        String id = call.getString("id");
        Integer messages = call.getInt("messages");
        synchronized (this) {
            Entry entry = id == null ? null : sockets.get(id);
            if (entry != null && messages != null) {
                for (int taken = 0; taken < messages && !entry.unacked.isEmpty(); taken++) entry.unackedBytes -= entry.unacked.poll();
            }
        }
        call.resolve();
    }

    private void closeAll() {
        Entry[] open;
        synchronized (this) { open = sockets.values().toArray(new Entry[0]); }
        for (Entry entry : open) if (entry.socket != null) entry.socket.close(1001, "page left");
    }
}
