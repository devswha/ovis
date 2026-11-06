package sh.ovis.app;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A plain `ws://` WebSocket client (RFC 6455) for one direct carrier (OvisDirectPlugin): the app has no
 * WebSocket library, and a carrier is never TLS (Noise inside the relay channel proves the PC). No
 * Android types, so it runs in JVM tests. Messages arrive in order on its reader thread; sends go out in
 * order on its writer thread. A message over MAX_MESSAGE ends the socket with 1009.
 */
final class DirectSocket {
    static final int MAX_MESSAGE = 4 * 1024 * 1024;
    private static final int CONNECT_MS = 10_000;
    private static final Pattern CARRIER = Pattern.compile("^ws://((?:0|[1-9]\\d{0,2})(?:\\.(?:0|[1-9]\\d{0,2})){3}):([1-9]\\d{0,4})/v1/ws\\?v=1$");

    interface Listener {
        void onText(String text);
        void onBinary(byte[] bytes);
        /** Once, last: `failed` when it broke rather than closed. */
        void onClose(int code, String reason, boolean failed);
    }

    /** host and port of `url` when it is exactly a direct carrier's channel address on a private IPv4 address, else null */
    static String[] carrier(String url) {
        if (url == null) return null;
        Matcher match = CARRIER.matcher(url);
        if (!match.matches()) return null;
        String[] octets = match.group(1).split("\\.");
        int a = Integer.parseInt(octets[0]);
        int b = Integer.parseInt(octets[1]);
        for (String octet : octets) if (Integer.parseInt(octet) > 255) return null;
        if (Integer.parseInt(match.group(2)) > 65535) return null;
        boolean privateAddress = a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254);
        return privateAddress ? new String[] { match.group(1), match.group(2) } : null;
    }

    private final String host;
    private final int port;
    private final Listener listener;
    private final Socket socket = new Socket();
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private final SecureRandom random = new SecureRandom();
    /** counted down once the handshake is done or the socket ended: no frame goes out before */
    private final CountDownLatch upgraded = new CountDownLatch(1);
    private boolean ended;
    private boolean closeSent;

    DirectSocket(String host, int port, Listener listener) {
        this.host = host;
        this.port = port;
        this.listener = listener;
    }

    void start() {
        writer.execute(() -> {
            try { upgraded.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        });
        Thread reader = new Thread(this::run, "ovis-direct");
        reader.setDaemon(true);
        reader.start();
    }

    void sendText(String text) {
        write(0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    void sendBinary(byte[] bytes) {
        write(0x2, bytes);
    }

    /** Starts the closing handshake; the peer's answer, or the socket's end, gives onClose. */
    void close(int code, String reason) {
        byte[] text = reason.getBytes(StandardCharsets.UTF_8);
        byte[] payload = new byte[2 + Math.min(text.length, 123)];
        payload[0] = (byte) (code >> 8);
        payload[1] = (byte) code;
        System.arraycopy(text, 0, payload, 2, payload.length - 2);
        writer.execute(() -> {
            synchronized (this) { if (closeSent || ended) return; closeSent = true; }
            try { frame(0x8, payload); } catch (IOException error) { end(1006, "", true); }
        });
        // a peer that never answers the close is let go
        writer.execute(() -> {
            try { Thread.sleep(5_000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            end(code, reason, false);
        });
    }

    private void write(int opcode, byte[] payload) {
        writer.execute(() -> {
            synchronized (this) { if (closeSent || ended) return; }
            try { frame(opcode, payload); } catch (IOException error) { end(1006, "", true); }
        });
    }

    /** One masked frame, as a client must send. Only the writer thread calls it. */
    private void frame(int opcode, byte[] payload) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(payload.length + 14);
        out.write(0x80 | opcode);
        if (payload.length < 126) {
            out.write(0x80 | payload.length);
        } else if (payload.length < 65536) {
            out.write(0x80 | 126);
            out.write(payload.length >> 8);
            out.write(payload.length);
        } else {
            out.write(0x80 | 127);
            for (int shift = 56; shift >= 0; shift -= 8) out.write((int) ((long) payload.length >> shift));
        }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        out.write(mask);
        for (int index = 0; index < payload.length; index++) out.write(payload[index] ^ mask[index & 3]);
        OutputStream stream = socket.getOutputStream();
        stream.write(out.toByteArray());
        stream.flush();
    }

    private void run() {
        try {
            socket.connect(new InetSocketAddress(host, port), CONNECT_MS);
            socket.setTcpNoDelay(true);
            DataInputStream in = new DataInputStream(socket.getInputStream());
            handshake(in);
            upgraded.countDown();
            read(in);
        } catch (IOException error) {
            end(1006, "", true);
        }
    }

    private void handshake(DataInputStream in) throws IOException {
        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        String key = Base64.getEncoder().encodeToString(nonce);
        String request = "GET /v1/ws?v=1 HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
        OutputStream out = socket.getOutputStream();
        out.write(request.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        String status = line(in);
        if (!status.startsWith("HTTP/1.1 101")) throw new IOException("not upgraded: " + status);
        String expected;
        try {
            expected = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IOException(error);
        }
        boolean accepted = false;
        for (String header = line(in); !header.isEmpty(); header = line(in)) {
            int colon = header.indexOf(':');
            if (colon > 0 && header.substring(0, colon).trim().equalsIgnoreCase("Sec-WebSocket-Accept")) accepted = header.substring(colon + 1).trim().equals(expected);
        }
        if (!accepted) throw new IOException("bad Sec-WebSocket-Accept");
    }

    /** One header line, at most 8 KiB. */
    private static String line(InputStream in) throws IOException {
        StringBuilder text = new StringBuilder();
        for (int byteRead; (byteRead = in.read()) != -1; ) {
            if (byteRead == '\n') return text.toString().replaceAll("\r$", "");
            if (text.length() > 8192) throw new IOException("header too long");
            text.append((char) byteRead);
        }
        throw new IOException("closed during the handshake");
    }

    private void read(DataInputStream in) throws IOException {
        ByteArrayOutputStream message = null;
        int messageType = 0;
        while (true) {
            int first = in.readUnsignedByte();
            int second = in.readUnsignedByte();
            boolean fin = (first & 0x80) != 0;
            int opcode = first & 0x0f;
            if ((second & 0x80) != 0) throw new IOException("a server frame is never masked");
            long length = second & 0x7f;
            if (length == 126) length = in.readUnsignedShort();
            else if (length == 127) length = in.readLong();
            if (length < 0 || length > MAX_MESSAGE || (opcode >= 0x8 && length > 125)) {
                close(1009, "message too big");
                end(1009, "message too big", false);
                return;
            }
            byte[] payload = new byte[(int) length];
            in.readFully(payload);
            switch (opcode) {
                case 0x8: {
                    int code = payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1005;
                    String reason = payload.length > 2 ? new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8) : "";
                    close(code == 1005 ? 1000 : code, "");
                    end(code, reason, false);
                    return;
                }
                case 0x9:
                    writer.execute(() -> { try { frame(0xA, payload); } catch (IOException error) { end(1006, "", true); } });
                    continue;
                case 0xA:
                    continue;
                case 0x1:
                case 0x2:
                    if (message != null) throw new IOException("a new message inside a fragmented one");
                    message = new ByteArrayOutputStream();
                    messageType = opcode;
                    break;
                case 0x0:
                    if (message == null) throw new IOException("a continuation without a message");
                    break;
                default:
                    throw new IOException("unknown opcode " + opcode);
            }
            if (message.size() + payload.length > MAX_MESSAGE) {
                close(1009, "message too big");
                end(1009, "message too big", false);
                return;
            }
            message.write(payload);
            if (!fin) continue;
            byte[] whole = message.toByteArray();
            message = null;
            synchronized (this) { if (ended) return; }
            if (messageType == 0x1) listener.onText(new String(whole, StandardCharsets.UTF_8));
            else listener.onBinary(whole);
        }
    }

    private void end(int code, String reason, boolean failed) {
        synchronized (this) {
            if (ended) return;
            ended = true;
        }
        upgraded.countDown();
        try { socket.close(); } catch (IOException ignored) { /* already gone */ }
        writer.shutdownNow();
        listener.onClose(code, reason, failed);
    }
}
