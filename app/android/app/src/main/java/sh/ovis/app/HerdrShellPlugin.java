package sh.ovis.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "HerdrShell")
public class HerdrShellPlugin extends Plugin {
    private final PCStore.Openings openings = new PCStore.Openings();
    @PluginMethod
    public void getState(PluginCall call) {
        JSObject state = new JSObject();
        state.put("saved", new JSArray(PCStore.saved(getContext())));
        state.put("names", PCStore.names(getContext()));
        String current = PCStore.current(getContext());
        String last = PCStore.last(getContext());
        state.put("name", last == null ? "" : PCStore.names(getContext()).optString(last, ""));
        state.put("current", current == null ? "" : current);
        state.put("last", last == null ? "" : last);
        state.put("failure", PCStore.failure == null ? "" : PCStore.failure);
        state.put("kind", PCStore.failureKind == null ? "" : PCStore.failureKind);
        state.put("command", PCStore.failureCommand == null ? "" : PCStore.failureCommand);
        call.resolve(state);
    }

    /** url: an http or https address, the first page (a pairing link's code or a relay pairing offer's fragment included). */
    @PluginMethod
    public void open(PluginCall call) {
        String text = call.getString("url");
        String key = text == null ? null : PCStore.origin(text);
        if (key == null) {
            call.reject("That is not an http or https address.");
            return;
        }
        if (SshPcs.otherLoopbackPort(text)) {
            call.reject("That address on this phone is kept for PCs added over SSH. Open the PC from Your PCs.");
            return;
        }
        String scope = call.getString("scope");
        if (scope != null) {
            key = PCStore.scopeKey(scope, text);
            if (key == null) {
                call.reject("That relay link is not within its PC's scope.");
                return;
            }
        }
        String name = call.getString("name");
        int mine = openings.start();
        if (!Boolean.TRUE.equals(call.getBoolean("check", false))) {
            openChecked(call, key, text, name, mine, 0);
            return;
        }
        String pc = key;
        String cookies = android.webkit.CookieManager.getInstance().getCookie(PCStore.origin(text));
        long answerBy = android.os.SystemClock.elapsedRealtime() + PCStore.ANSWER_SECONDS * 1000L;
        new Thread(() -> {
            PCStore.Check found = PCStore.check(text, cookies, PCStore.ANSWER_SECONDS * 1000L);
            if (found.opens()) openChecked(call, pc, text, name, mine, answerBy);
            else call.reject(found.detail == null ? found.kind : found.detail, found.kind);
        }, "ovis-check").start();
    }

    private void openChecked(PluginCall call, String key, String text, String name, int mine, long answerBy) {
        synchronized (openings) {
            android.app.Activity activity = getActivity();
            if (!openings.current(mine) || activity == null || activity.isFinishing() || activity.isDestroyed()) {
                call.reject("Cancelled", "cancelled");
                return;
            }
            if (name != null && !name.isEmpty()) PCStore.setName(getContext(), key, name.length() > 64 ? name.substring(0, 64) : name);
            PCStore.open(getContext(), key, text);
            PCStore.fail(null, null);
            PCStore.redirects = 0;
            PCStore.answerBy = answerBy;
        }
        call.resolve();
        android.app.Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            synchronized (openings) {
                if (!openings.current(mine)) {
                    PCStore.setCurrent(getContext(), null);
                    PCStore.answerBy = 0;
                    return;
                }
            }
            ((MainActivity) activity).reopen();
        });
    }

    @PluginMethod
    public void cancelOpen(PluginCall call) {
        openings.cancel();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        openings.cancel();
        super.handleOnDestroy();
    }

    private boolean showingConnectScreen() {
        return getBridge().getServerUrl() == null;
    }

    /**
     * A PC's page has the bridge too: an activity showing a PC (its
     * server URL is the PC's) never hands the link out, as it may hold another PC's pairing code.
     */
    @PluginMethod
    public void takeLink(PluginCall call) {
        String link = null;
        if (showingConnectScreen()) {
            link = PCStore.link;
            PCStore.link = null;
        }
        JSObject result = new JSObject();
        result.put("url", link == null ? "" : link);
        call.resolve(result);
    }

    /** For the connect screen's Tailscale tab: `on`, Tailscale's VPN is up on this phone (Tailnet.on). */
    @PluginMethod
    public void tailscale(PluginCall call) {
        JSObject result = new JSObject();
        result.put("on", Tailnet.on());
        call.resolve(result);
    }

    /** Opens the Tailscale app to turn it on, or its store page when it is not installed (the manifest's queries). */
    @PluginMethod
    public void openTailscale(PluginCall call) {
        android.content.Intent open = getContext().getPackageManager().getLaunchIntentForPackage(Tailnet.PACKAGE);
        if (open == null) {
            open = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://play.google.com/store/apps/details?id=" + Tailnet.PACKAGE));
        }
        try {
            getActivity().startActivity(open);
            call.resolve();
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("Tailscale could not be opened on this phone.");
        }
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String key = call.getString("url");
        // an SSH PC forgotten takes its sealed key and host key with it (OvisSshPlugin.forgetRemoved): only the app's
        // own pages do that, never a PC's page, which has this bridge too
        if (key != null && getBridge().getServerUrl() != null && SshPcs.on(getContext()).get(key) != null) {
            call.reject("Only the app's own pages manage SSH PCs.");
            return;
        }
        if (key != null) PCStore.forget(getContext(), key);
        call.resolve();
    }

    /**
     * From any page of the app, a PC's (the hosted app's) included: the app's own connect screen, on Direct with
     * `target` (an SSH login, user@host[:port], or empty) in its field. Nothing is added here, and no PC page is given
     * OvisSsh: the connect screen, an app page, takes the login to the SSH setup screen, where the person adds the PC.
     */
    @PluginMethod
    public void openSshSetup(PluginCall call) {
        String target = call.getString("target", "");
        if (target == null || target.length() > 300) {
            call.reject("That is not an SSH login.");
            return;
        }
        PCStore.sshSetup = target;
        PCStore.setCurrent(getContext(), null);
        call.resolve();
        reopen();
    }

    /** The connect screen's alone: the SSH login a page asked it to open with (openSshSetup), taken once. */
    @PluginMethod
    public void takeSshSetup(PluginCall call) {
        String target = null;
        if (showingConnectScreen()) {
            target = PCStore.sshSetup;
            PCStore.sshSetup = null;
        }
        JSObject result = new JSObject();
        result.put("asked", target != null);
        result.put("target", target == null ? "" : target);
        call.resolve(result);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        PCStore.setCurrent(getContext(), null);
        call.resolve();
        reopen();
    }

    @PluginMethod
    public void retry(PluginCall call) {
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    private void reopen() {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }

    /** How long the connect screen's Direct tab listens for PCs on this Wi-Fi before it lists what it found. */
    private static final long LAN_BROWSE_MS = 3_000;

    /**
     * The connect screen's alone: the Ovis PCs on this Wi-Fi that let a phone join now (LanPcs), as
     * `pcs: [{ name, host, port }]`, after LAN_BROWSE_MS of NsdManager browsing. Only private IPv4 addresses are listed.
     */
    @PluginMethod
    public void findLanPcs(PluginCall call) {
        if (!showingConnectScreen()) {
            call.reject("Only the app's own connect screen looks for PCs on this Wi-Fi.");
            return;
        }
        android.net.nsd.NsdManager nsd = (android.net.nsd.NsdManager) getContext().getSystemService(android.content.Context.NSD_SERVICE);
        if (nsd == null) {
            call.reject("This phone cannot look for PCs on its Wi-Fi.");
            return;
        }
        java.util.Map<String, JSObject> found = new java.util.LinkedHashMap<>();
        java.util.ArrayDeque<android.net.nsd.NsdServiceInfo> toResolve = new java.util.ArrayDeque<>();
        boolean[] resolving = { false };
        Object lock = new Object();
        Runnable[] next = new Runnable[1];
        next[0] = () -> {
            android.net.nsd.NsdServiceInfo service;
            synchronized (lock) {
                if (resolving[0] || toResolve.isEmpty()) return;
                service = toResolve.poll();
                resolving[0] = true;
            }
            // one resolve at a time: older NsdManagers refuse a second while one runs
            nsd.resolveService(service, new android.net.nsd.NsdManager.ResolveListener() {
                @Override public void onResolveFailed(android.net.nsd.NsdServiceInfo info, int error) { done(); }
                @Override public void onServiceResolved(android.net.nsd.NsdServiceInfo info) {
                    java.net.InetAddress address = info.getHost();
                    String host = address == null ? null : address.getHostAddress();
                    if (LanPcs.lanHost(host) && LanPcs.offerUrl(host, info.getPort()) != null) {
                        JSObject pc = new JSObject();
                        pc.put("name", LanPcs.shownName(info.getServiceName()));
                        pc.put("host", host);
                        pc.put("port", info.getPort());
                        synchronized (lock) { found.put(host + ":" + info.getPort(), pc); }
                    }
                    done();
                }
                private void done() {
                    synchronized (lock) { resolving[0] = false; }
                    next[0].run();
                }
            });
        };
        android.net.nsd.NsdManager.DiscoveryListener listener = new android.net.nsd.NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String type, int error) { }
            @Override public void onStopDiscoveryFailed(String type, int error) { }
            @Override public void onDiscoveryStarted(String type) { }
            @Override public void onDiscoveryStopped(String type) { }
            @Override public void onServiceFound(android.net.nsd.NsdServiceInfo service) {
                synchronized (lock) { toResolve.add(service); }
                next[0].run();
            }
            @Override public void onServiceLost(android.net.nsd.NsdServiceInfo service) { }
        };
        try {
            nsd.discoverServices(LanPcs.SERVICE_TYPE, android.net.nsd.NsdManager.PROTOCOL_DNS_SD, listener);
        } catch (RuntimeException failed) {
            call.reject("This phone cannot look for PCs on its Wi-Fi.");
            return;
        }
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            try { nsd.stopServiceDiscovery(listener); } catch (RuntimeException alreadyStopped) { }
            JSArray pcs = new JSArray();
            synchronized (lock) { for (JSObject pc : found.values()) pcs.put(pc); }
            JSObject result = new JSObject();
            result.put("pcs", pcs);
            call.resolve(result);
        }, LAN_BROWSE_MS);
    }

    /** The connect screen's alone: what a PC found on this Wi-Fi answers at /v1/offer (LanPcs.readOffer), as `offer` text. */
    @PluginMethod
    public void lanOffer(PluginCall call) {
        if (!showingConnectScreen()) {
            call.reject("Only the app's own connect screen asks a PC on this Wi-Fi.");
            return;
        }
        String host = call.getString("host");
        Integer port = call.getInt("port");
        if (port == null || LanPcs.offerUrl(host, port) == null) {
            call.reject("That is not an address on this Wi-Fi.");
            return;
        }
        new Thread(() -> {
            String offer = LanPcs.readOffer(host, port);
            if (offer == null) {
                call.reject("That PC no longer lets a phone join. Open Add a connection, then Direct, on the PC.");
                return;
            }
            JSObject result = new JSObject();
            result.put("offer", offer);
            call.resolve(result);
        }, "ovis-lan-offer").start();
    }
}
