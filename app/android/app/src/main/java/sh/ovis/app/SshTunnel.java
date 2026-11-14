package sh.ovis.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import com.trilead.ssh2.Connection;
import com.trilead.ssh2.LocalStreamForwarder;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The WebView's way to an SSH PC: a listener on the PC's loopback origin on this phone, each of whose
 * connections becomes an SSH direct-tcpip channel to the PC's own Ovis on its 127.0.0.1. That Ovis
 * sees a request from its own loopback with no proxy headers, which it lets in as its own PC's
 * (server/access.ts decideAccess, `local`): no token is typed or kept.
 *
 * Every app on the phone can reach the phone's loopback, so a connection is passed on only when its
 * first request carries the PC's gate cookie, which the app put in the WebView's cookie store and no
 * other app can read; anything else gets 403 and nothing reaches the PC.
 *
 * The SSH connection is made when the first request needs it, and again after it ended (the app in
 * the background, a network change): reconnecting asks nothing, with the key and host key saved when
 * the PC was added. A changed host key or a refused key stops it until the PC is added again.
 */
final class SshTunnel {
    static final String GATE_COOKIE = "ovis_ssh_gate";
    /** a failure is not retried for this long: the page's burst of requests gets the same answer at once */
    private static final long RETRY_AFTER_MS = 2_000;
    private static final int HEAD_LIMIT = 64 * 1024;

    interface FailureListener {
        void onFailure(SshPcs.Pc pc, SshLink.Failure failure);
    }

    private static final Map<String, SshTunnel> tunnels = new HashMap<>();
    static volatile FailureListener listener;
    private static ConnectivityManager.NetworkCallback networkWatch;

    private final Context app;
    private final SshPcs.Pc pc;
    private final ExecutorService pipes = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "ovis-ssh-pipe");
        thread.setDaemon(true);
        return thread;
    });
    private ServerSocket server;
    private Connection connection;
    private int remotePort;
    private SshLink.Failure lastFailure;
    private long failedAt;
    /** a host key or a sign-in that failed: nothing is tried again until the PC is added again */
    private SshLink.Failure stopped;

    private SshTunnel(Context app, SshPcs.Pc pc) {
        this.app = app;
        this.pc = pc;
    }

    /** The tunnel for `pc`, listening: started on first use, kept for the process's life. */
    static synchronized SshTunnel open(Context context, SshPcs.Pc pc) throws IOException {
        SshTunnel tunnel = tunnels.get(pc.origin);
        if (tunnel != null && tunnel.pc.hostKey.equals(pc.hostKey) && tunnel.pc.gate.equals(pc.gate) && tunnel.pc.auth.equals(pc.auth)) return tunnel;
        if (tunnel != null) tunnel.close();
        tunnel = new SshTunnel(context.getApplicationContext(), pc);
        tunnel.listen();
        tunnels.put(pc.origin, tunnel);
        watchNetwork(context.getApplicationContext());
        return tunnel;
    }

    static synchronized void closeAll() {
        for (SshTunnel tunnel : tunnels.values()) tunnel.close();
        tunnels.clear();
    }

    static synchronized void closeFor(String origin) {
        SshTunnel tunnel = tunnels.remove(origin);
        if (tunnel != null) tunnel.close();
    }

    /** The app came back: a connection that no longer answers is dropped and made again before the page asks. */
    static void wakeAll() {
        SshTunnel[] all;
        synchronized (SshTunnel.class) {
            all = tunnels.values().toArray(new SshTunnel[0]);
        }
        for (SshTunnel tunnel : all) new Thread(tunnel::wake, "ovis-ssh-wake").start();
    }

    private static void watchNetwork(Context app) {
        if (networkWatch != null) return;
        ConnectivityManager manager = app.getSystemService(ConnectivityManager.class);
        if (manager == null) return;
        networkWatch = new ConnectivityManager.NetworkCallback() {
            private Network current;

            @Override
            public void onAvailable(Network network) {
                Network before = current;
                current = network;
                // the first call names the network there already is; a later one is a switch, and
                // the connection made over the network before may never hear that it is gone
                if (before != null && !before.equals(network)) dropAll();
            }

            @Override
            public void onLost(Network network) {
                if (network.equals(current)) current = null;
                dropAll();
            }
        };
        manager.registerDefaultNetworkCallback(networkWatch);
    }

    private static void dropAll() {
        SshTunnel[] all;
        synchronized (SshTunnel.class) {
            all = tunnels.values().toArray(new SshTunnel[0]);
        }
        for (SshTunnel tunnel : all) tunnel.drop();
    }

    private void listen() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(InetAddress.getByName(pc.loopbackHost()), SshPcs.LOCAL_PORT), 64);
        Thread accept = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket client = server.accept();
                    pipes.execute(() -> serve(client));
                } catch (IOException closed) {
                    return;
                }
            }
        }, "ovis-ssh-accept");
        accept.setDaemon(true);
        accept.start();
    }

    private void close() {
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
            // closing a listener that is already gone
        }
        drop();
        pipes.shutdownNow();
    }

    private synchronized void drop() {
        if (connection != null) connection.close();
        connection = null;
    }

    private void wake() {
        Connection now;
        synchronized (this) {
            now = connection;
        }
        if (now != null && !answers(now)) {
            synchronized (this) {
                if (connection == now) drop();
            }
        }
        try {
            ready();
        } catch (SshLink.Failure failed) {
            // told to the page's next request, and to the listener for the stops
        }
    }

    private static boolean answers(Connection connection) {
        final boolean[] answered = { false };
        Thread ping = new Thread(() -> {
            try {
                connection.ping();
                answered[0] = true;
            } catch (IOException gone) {
                // not answered
            }
        }, "ovis-ssh-ping");
        ping.setDaemon(true);
        ping.start();
        try {
            ping.join(4_000);
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        }
        return answered[0];
    }

    private synchronized Connection ready() throws SshLink.Failure {
        if (stopped != null) throw stopped;
        if (connection != null) return connection;
        if (lastFailure != null && System.currentTimeMillis() - failedAt < RETRY_AFTER_MS) throw lastFailure;
        Connection made = null;
        try {
            made = SshLink.connect(pc.host, pc.port, new SshLink.HostKeyCheck(pc.hostKeyAlgorithm, pc.hostKey));
            if ("imported".equals(pc.auth)) {
                SshLink.signInWithImported(made, pc.user, SshVault.openText(pc.importedKey), pc.importedPassphrase.isEmpty() ? null : SshVault.openText(pc.importedPassphrase));
            } else {
                SshLink.signInWithKey(made, pc.user, SshPcs.phoneKey(app));
            }
            remotePort = SshLink.ovisPort(made);
            Connection mine = made;
            made.addConnectionMonitor(reason -> {
                synchronized (SshTunnel.this) {
                    if (connection == mine) connection = null;
                }
            });
            connection = made;
            lastFailure = null;
            return made;
        } catch (SshLink.Failure failed) {
            if (made != null) made.close();
            remember(failed);
            throw failed;
        } catch (Exception unreadable) {
            if (made != null) made.close();
            SshLink.Failure failed = new SshLink.Failure("key-unreadable", SshLink.rootMessage(unreadable));
            remember(failed);
            throw failed;
        }
    }

    private void remember(SshLink.Failure failed) {
        lastFailure = failed;
        failedAt = System.currentTimeMillis();
        boolean stop = failed.kind.equals("host-key-changed") || failed.kind.equals("auth") || failed.kind.equals("key-unreadable");
        if (stop) stopped = failed;
        FailureListener told = listener;
        if (told != null && (stop || failed.kind.equals("no-ovis") || failed.kind.equals("not-started") || failed.kind.equals("unsupported"))) {
            told.onFailure(pc, failed);
        }
    }

    /** A channel to the PC's Ovis; after a failed open the Ovis is looked up again once (it may have restarted on another port). */
    private LocalStreamForwarder channel() throws SshLink.Failure {
        Connection now = ready();
        try {
            return now.createLocalStreamForwarder("127.0.0.1", remotePort);
        } catch (IOException refused) {
            synchronized (this) {
                if (connection == now) {
                    try {
                        remotePort = SshLink.ovisPort(now);
                    } catch (SshLink.Failure gone) {
                        remember(gone);
                        throw gone;
                    }
                }
            }
            try {
                return ready().createLocalStreamForwarder("127.0.0.1", remotePort);
            } catch (IOException again) {
                drop();
                throw new SshLink.Failure("unreachable", SshLink.rootMessage(again));
            }
        }
    }

    private void serve(Socket client) {
        try {
            client.setSoTimeout(15_000);
            InputStream fromPage = client.getInputStream();
            OutputStream toPage = client.getOutputStream();
            byte[] head = readHead(fromPage);
            if (head == null || !carriesGate(head)) {
                toPage.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                toPage.flush();
                client.close();
                return;
            }
            LocalStreamForwarder stream;
            try {
                stream = channel();
            } catch (SshLink.Failure failed) {
                String reason = ("SSH " + failed.kind).replaceAll("[^A-Za-z0-9 -]", "");
                byte[] body = failed.getMessage() == null ? new byte[0] : failed.getMessage().getBytes(StandardCharsets.UTF_8);
                toPage.write(("HTTP/1.1 503 " + reason + "\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                toPage.write(body);
                toPage.flush();
                client.close();
                return;
            }
            client.setSoTimeout(0);
            OutputStream toPc = stream.getOutputStream();
            toPc.write(head);
            toPc.flush();
            pipes.execute(() -> pump(fromPage, toPc, client, stream));
            pump(stream.getInputStream(), toPage, client, stream);
        } catch (IOException | java.util.concurrent.RejectedExecutionException ended) {
            closeQuietly(client);
        }
    }

    /**
     * The request head, up to its blank line, or null when the page closed first or sent more than
     * HEAD_LIMIT without one. Bytes after the blank line (a body) are left in the stream.
     */
    private static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (head.size() < HEAD_LIMIT) {
            int next = in.read();
            if (next < 0) return null;
            head.write(next);
            matched = (next == '\r' && (matched == 0 || matched == 2)) || (next == '\n' && (matched == 1 || matched == 3)) ? matched + 1 : (next == '\r' ? 1 : 0);
            if (matched == 4) return head.toByteArray();
        }
        return null;
    }

    private boolean carriesGate(byte[] head) {
        String text = new String(head, StandardCharsets.ISO_8859_1);
        byte[] gate = pc.gate.getBytes(StandardCharsets.US_ASCII);
        for (String line : text.split("\r\n")) {
            if (!line.toLowerCase(Locale.ROOT).startsWith("cookie:")) continue;
            for (String pair : line.substring("cookie:".length()).split(";")) {
                String[] parts = pair.trim().split("=", 2);
                if (parts.length == 2 && parts[0].equals(GATE_COOKIE) && MessageDigest.isEqual(parts[1].getBytes(StandardCharsets.US_ASCII), gate)) return true;
            }
        }
        return false;
    }

    private static void pump(InputStream from, OutputStream to, Socket client, LocalStreamForwarder stream) {
        byte[] buffer = new byte[32 * 1024];
        try {
            int read;
            while ((read = from.read(buffer)) >= 0) {
                to.write(buffer, 0, read);
                to.flush();
            }
        } catch (IOException ended) {
            // either side went away
        } finally {
            closeQuietly(client);
            try {
                stream.close();
            } catch (IOException ignored) {
                // already closed by the other direction
            }
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // already closed
        }
    }
}
