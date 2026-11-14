package sh.ovis.app;

import android.util.Base64;
import com.trilead.ssh2.ChannelCondition;
import com.trilead.ssh2.Connection;
import com.trilead.ssh2.ServerHostKeyVerifier;
import com.trilead.ssh2.Session;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import org.json.JSONObject;

/**
 * One SSH connection to a PC and what the app does over it, following what Ovis on a PC does to add a
 * PC over SSH (server/remote-host.ts, server/pc-install.ts): read the bridge descriptors under
 * ~/.config/herdr-web-ui/bridges for a running Ovis, start an installed one through its own launcher,
 * and add a key line to authorized_keys. Only an Ovis that serves its own app (not a bridge another
 * PC's Ovis started, which serves that PC alone) can be opened from the phone.
 */
final class SshLink {
    static final String REMOTE_PATH = "export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; ";
    static final String INSTALL_COMMAND = "curl -fsSL https://ovis.sh/install.sh | sh";

    private SshLink() {}

    static final class Failure extends Exception {
        final String kind;

        Failure(String kind, String message) {
            super(message);
            this.kind = kind;
        }
    }

    /**
     * Trust on first use, with the user's confirmation. With no expected key the connection is refused
     * as soon as the key is read (nothing is sent to an unconfirmed host, a password least of all), and
     * the key is shown; with one, any other key fails closed.
     */
    static final class HostKeyCheck implements ServerHostKeyVerifier {
        final String expectedAlgorithm;
        final String expectedKey;
        String seenAlgorithm;
        byte[] seenKey;
        boolean changed;

        HostKeyCheck(String expectedAlgorithm, String expectedKey) {
            this.expectedAlgorithm = expectedAlgorithm;
            this.expectedKey = expectedKey;
        }

        @Override
        public boolean verifyServerHostKey(String hostname, int port, String algorithm, byte[] key) {
            seenAlgorithm = algorithm;
            seenKey = key;
            if (expectedKey == null || expectedKey.isEmpty()) return false;
            boolean same = algorithm.equals(expectedAlgorithm) && MessageDigest.isEqual(Base64.decode(expectedKey, Base64.NO_WRAP), key);
            changed = !same;
            return same;
        }
    }

    static String fingerprint(byte[] key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(key);
            return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP | Base64.NO_PADDING);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static Connection connect(String host, int port, HostKeyCheck check) throws Failure {
        Connection connection = new Connection(host, port);
        if (check.expectedAlgorithm != null && !check.expectedAlgorithm.isEmpty()) {
            // the server must show the very kind of key that was confirmed, or the comparison means nothing
            connection.setServerHostKeyAlgorithms(new String[] { check.expectedAlgorithm });
        }
        try {
            connection.connect(check, 10_000, 15_000);
            return connection;
        } catch (IOException failed) {
            connection.close();
            if (check.changed) throw new Failure("host-key-changed", "The host key changed");
            if (check.seenKey != null && (check.expectedKey == null || check.expectedKey.isEmpty())) throw new Failure("unknown-host", "Unknown host key");
            if (check.seenKey == null && check.expectedAlgorithm != null && !check.expectedAlgorithm.isEmpty() && String.valueOf(failed.getMessage()).contains("host key")) {
                throw new Failure("host-key-changed", "The machine no longer offers the host key type confirmed before");
            }
            throw new Failure("unreachable", rootMessage(failed));
        }
    }

    static String rootMessage(Throwable failed) {
        Throwable cause = failed;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        String message = cause.getMessage();
        return message == null ? cause.getClass().getSimpleName() : message;
    }

    static void signInWithKey(Connection connection, String user, KeyPair pair) throws Failure {
        try {
            if (!connection.authenticateWithPublicKey(user, pair)) throw new Failure("auth", "The machine refused this phone's key");
        } catch (IOException failed) {
            throw new Failure("unreachable", rootMessage(failed));
        }
    }

    static void signInWithImported(Connection connection, String user, String pem, String passphrase) throws Failure {
        boolean accepted;
        try {
            accepted = connection.authenticateWithPublicKey(user, pem.toCharArray(), passphrase == null || passphrase.isEmpty() ? null : passphrase);
        } catch (IOException failed) {
            if (!connection.isAuthenticationComplete() && rootMessage(failed).toLowerCase(java.util.Locale.ROOT).contains("decrypt")) {
                throw new Failure("key-unreadable", "The private key could not be read with that passphrase");
            }
            throw new Failure("key-unreadable", rootMessage(failed));
        }
        if (!accepted) throw new Failure("auth", "The machine refused that key");
    }

    static void signInWithPassword(Connection connection, String user, String password) throws Failure {
        try {
            if (connection.isAuthMethodAvailable(user, "password") && connection.authenticateWithPassword(user, password)) return;
            if (connection.isAuthMethodAvailable(user, "keyboard-interactive")) {
                boolean done = connection.authenticateWithKeyboardInteractive(user, (name, instruction, count, prompts, echo) -> {
                    String[] answers = new String[count];
                    java.util.Arrays.fill(answers, password);
                    return answers;
                });
                if (done) return;
            }
        } catch (IOException failed) {
            throw new Failure("unreachable", rootMessage(failed));
        }
        throw new Failure("auth", "The machine refused that password");
    }

    static String run(Connection connection, String command, long timeoutMs) throws Failure {
        Session session = null;
        try {
            session = connection.openSession();
            session.execCommand(command);
            InputStream out = session.getStdout();
            InputStream err = session.getStderr();
            ByteArrayOutputStream text = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            long end = System.currentTimeMillis() + timeoutMs;
            while (true) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) throw new Failure("timeout", "The machine did not answer in time");
                int state = session.waitForCondition(ChannelCondition.STDOUT_DATA | ChannelCondition.STDERR_DATA | ChannelCondition.EOF, left);
                if ((state & ChannelCondition.TIMEOUT) != 0) throw new Failure("timeout", "The machine did not answer in time");
                while (out.available() > 0) {
                    int read = out.read(buffer);
                    if (read > 0 && text.size() < 512 * 1024) text.write(buffer, 0, read);
                }
                while (err.available() > 0) err.read(buffer);
                if ((state & ChannelCondition.EOF) != 0 && out.available() == 0 && err.available() == 0) break;
            }
            session.waitForCondition(ChannelCondition.EXIT_STATUS, 2_000);
            return text.toString("UTF-8");
        } catch (IOException failed) {
            throw new Failure("unreachable", rootMessage(failed));
        } finally {
            if (session != null) session.close();
        }
    }

    static final class Found {
        int port;
        String launcher = "none";
        String system = "";
        boolean bridgeOnly;
    }

    /**
     * The live descriptors (their PID answers kill -0, as server/remote-host.ts checks), and the
     * launcher test of server/pc-install.ts.
     */
    static final String DISCOVER =
        REMOTE_PATH +
        "uname -s; " +
        "for f in \"$HOME/.config/herdr-web-ui/bridges/\"*.json; do test -f \"$f\" && test ! -L \"$f\" || continue; " +
        "c=$(head -c 16384 \"$f\" | tr -d '\\n'); pid=$(printf '%s' \"$c\" | sed -n 's/.*\"pid\":\\([0-9][0-9]*\\).*/\\1/p'); " +
        "test -n \"$pid\" && kill -0 \"$pid\" 2>/dev/null && printf 'D %s\\n' \"$c\"; done; " +
        "plugins=$(herdr plugin list 2>/dev/null </dev/null); " +
        "if printf '%s\\n' \"$plugins\" | grep -q 'devswha.ovis '; then echo launcher=plugin; " +
        "elif printf '%s\\n' \"$plugins\" | grep -q 'devswha.herdr-web-ui '; then echo launcher=plugin-legacy; " +
        "elif systemctl --user cat ovis.service >/dev/null 2>&1; then echo launcher=systemd; " +
        "elif test -f \"$HOME/Library/LaunchAgents/sh.ovis.server.plist\"; then echo launcher=launchd; " +
        "else echo launcher=none; fi";

    static Found discover(Connection connection) throws Failure {
        String answer = run(connection, DISCOVER, 20_000);
        Found found = new Found();
        String[] lines = answer.split("\n");
        if (lines.length > 0) found.system = lines[0].trim();
        int fallback = 0;
        for (String line : lines) {
            if (line.startsWith("launcher=")) found.launcher = line.substring("launcher=".length()).trim();
            if (!line.startsWith("D ")) continue;
            try {
                JSONObject descriptor = new JSONObject(line.substring(2));
                int port = descriptor.optInt("port", 0);
                if (port <= 0 || port > 65535) continue;
                // a bridge another PC's Ovis started serves that PC, with a token the phone never has
                if (descriptor.optBoolean("managed_remote", false)) {
                    found.bridgeOnly = true;
                    continue;
                }
                if (descriptor.optString("socket_path").endsWith("/herdr/herdr.sock")) {
                    found.port = port;
                    break;
                }
                if (fallback == 0) fallback = port;
            } catch (org.json.JSONException unreadable) {
                // a descriptor being rewritten; the next look reads it whole
            }
        }
        if (found.port == 0) found.port = fallback;
        return found;
    }

    /** Starts an installed Ovis through its own launcher, as server/pc-install.ts viaLauncher does. */
    static void startOvis(Connection connection, String launcher) throws Failure {
        String command;
        switch (launcher) {
            case "plugin":
                command = REMOTE_PATH + "herdr plugin action invoke devswha.ovis.start >/dev/null </dev/null";
                break;
            case "plugin-legacy":
                command = REMOTE_PATH + "herdr plugin action invoke devswha.herdr-web-ui.start >/dev/null </dev/null";
                break;
            case "systemd":
                command = "systemctl --user start ovis.service </dev/null";
                break;
            case "launchd":
                command = "launchctl kickstart gui/$(id -u)/sh.ovis.server </dev/null";
                break;
            default:
                throw new Failure("no-ovis", "Ovis is not installed there");
        }
        run(connection, command + " 2>&1; true", 30_000);
    }

    /**
     * The port of the PC's own Ovis: a running one, else an installed one started through its launcher
     * (waiting up to 30 s for it to register). A PC with none fails with `no-ovis`.
     */
    static int ovisPort(Connection connection) throws Failure {
        Found found = discover(connection);
        if (!found.system.equals("Linux") && !found.system.equals("Darwin")) {
            throw new Failure("unsupported", "Only Linux and macOS machines can be opened from the phone for now");
        }
        if (found.port > 0) return found.port;
        if (found.launcher.equals("none")) throw new Failure("no-ovis", found.bridgeOnly ? "bridge-only" : "none");
        startOvis(connection, found.launcher);
        long end = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < end) {
            try {
                Thread.sleep(1_000);
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
                throw new Failure("cancelled", "Cancelled");
            }
            found = discover(connection);
            if (found.port > 0) return found.port;
        }
        throw new Failure("not-started", "Ovis did not start there within 30 seconds");
    }

    /** Adds `keyLine` to the account's authorized_keys once, as server/remote-host.ts authorizeKey does. */
    static void authorizeKey(Connection connection, String keyLine) throws Failure {
        if (!keyLine.matches("[A-Za-z0-9+/=:._ -]+")) throw new Failure("internal", "Unexpected characters in the key line");
        run(
            connection,
            "set -eu; umask 077; mkdir -p \"$HOME/.ssh\"; touch \"$HOME/.ssh/authorized_keys\"; key='" + keyLine + "'; " +
            "grep -qxF \"$key\" \"$HOME/.ssh/authorized_keys\" || printf '\\n%s\\n' \"$key\" >> \"$HOME/.ssh/authorized_keys\"; chmod 600 \"$HOME/.ssh/authorized_keys\"",
            20_000
        );
    }

    /**
     * Asks the PC's Ovis for /api/health through the connection itself, as PCStore.check asks an address:
     * true when it answers as Ovis.
     */
    static boolean answersAsOvis(Connection connection, int port) throws Failure {
        try {
            com.trilead.ssh2.LocalStreamForwarder stream = connection.createLocalStreamForwarder("127.0.0.1", port);
            try {
                OutputStream out = stream.getOutputStream();
                out.write(("GET /api/health?scope=bridge HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\nAccept: application/json\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.flush();
                InputStream in = stream.getInputStream();
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0 && body.size() < 256 * 1024) body.write(buffer, 0, read);
                String response = body.toString("UTF-8");
                int start = response.indexOf("\r\n\r\n");
                if (start < 0) return false;
                String head = response.substring(0, start);
                String text = response.substring(start + 4);
                if (head.toLowerCase(java.util.Locale.ROOT).contains("transfer-encoding: chunked")) text = unchunk(text);
                return PCStore.answersAsServer(text);
            } finally {
                stream.close();
            }
        } catch (IOException failed) {
            throw new Failure("unreachable", rootMessage(failed));
        }
    }

    private static String unchunk(String chunked) {
        StringBuilder out = new StringBuilder();
        int at = 0;
        while (at < chunked.length()) {
            int line = chunked.indexOf("\r\n", at);
            if (line < 0) break;
            int size;
            try {
                size = Integer.parseInt(chunked.substring(at, line).split(";")[0].trim(), 16);
            } catch (NumberFormatException damaged) {
                break;
            }
            if (size == 0) break;
            int from = line + 2;
            int to = Math.min(chunked.length(), from + size);
            out.append(chunked, from, to);
            at = to + 2;
        }
        return out.toString();
    }
}
