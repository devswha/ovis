package sh.ovis.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Ovis PCs on this phone's Wi-Fi (docs/relay.md, "Joining on the same Wi-Fi"): a PC whose own window lets a phone join
 * advertises `_ovis._tcp` over multicast DNS, which HerdrShellPlugin.findLanPcs browses with NsdManager. Only a private
 * IPv4 address (RFC 1918, link-local) is taken, never a Tailscale or public one, and what the PC answers at
 * `/v1/offer` is read here and handed to the connect screen, which pairs by comparing digits: the address and what it
 * answers are only a hint, the digits both screens show prove the PC.
 */
final class LanPcs {
    /** the DNS-SD service type, as NsdManager takes it */
    static final String SERVICE_TYPE = "_ovis._tcp.";
    static final int OFFER_TIMEOUT_MS = 3_000;
    /** a PC's offer is a few hundred bytes; anything past this is not one */
    static final int MAX_OFFER_BYTES = 4096;

    private static final Pattern IPV4 = Pattern.compile("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})");

    private LanPcs() {}

    /** Whether `host` is a private IPv4 address on this Wi-Fi: RFC 1918 or link-local, never loopback, Tailscale or public. */
    static boolean lanHost(String host) {
        if (host == null) return false;
        Matcher match = IPV4.matcher(host);
        if (!match.matches()) return false;
        int[] octets = new int[4];
        for (int index = 0; index < 4; index++) {
            octets[index] = Integer.parseInt(match.group(index + 1));
            if (octets[index] > 255) return false;
        }
        int a = octets[0];
        int b = octets[1];
        return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254);
    }

    /** The address of a found PC's offer, or null for an address or port this phone does not ask. */
    static String offerUrl(String host, int port) {
        if (!lanHost(host) || port < 1 || port > 65535) return null;
        return "http://" + host + ":" + port + "/v1/offer";
    }

    /** What the PC at `host`:`port` answers at /v1/offer, as text; null when it answers nothing that could be one. */
    static String readOffer(String host, int port) {
        String url = offerUrl(host, port);
        if (url == null) return null;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(OFFER_TIMEOUT_MS);
            connection.setReadTimeout(OFFER_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            if (connection.getResponseCode() != 200) return null;
            try (InputStream in = connection.getInputStream()) {
                return readCapped(in);
            }
        } catch (IOException | RuntimeException failed) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** At most MAX_OFFER_BYTES of UTF-8, or null past them. */
    static String readCapped(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        for (int read; (read = in.read(buffer)) != -1; ) {
            out.write(buffer, 0, read);
            if (out.size() > MAX_OFFER_BYTES) return null;
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** The name a PC advertised, as the list shows it: NsdManager hands it with `\032` for a space on some versions. */
    static String shownName(String name) {
        if (name == null) return "";
        return name.replace("\\032", " ").trim();
    }
}
