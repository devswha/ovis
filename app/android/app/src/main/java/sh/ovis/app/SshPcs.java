package sh.ovis.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import com.trilead.ssh2.crypto.keys.Ed25519KeyPairGenerator;
import com.trilead.ssh2.crypto.keys.Ed25519PrivateKey;
import com.trilead.ssh2.crypto.keys.Ed25519PublicKey;
import com.trilead.ssh2.signature.Ed25519Verify;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The PCs added over SSH. Each is saved in PCStore under its own loopback origin on this phone
 * (`http://127.0.0.<n>:47317`, SshTunnel listens there); this store keeps how to reach it: address,
 * account, the host key confirmed when it was added, and how the app signs in. A distinct 127.0.0.n
 * per PC keeps each PC's cookies and storage apart, as cookies do not separate ports.
 */
final class SshPcs {
    static final int LOCAL_PORT = 47317;
    private static final String PREFS = "ovis-ssh";

    private SshPcs() {}

    static final class Pc {
        String origin;
        String host;
        int port;
        String user;
        String hostKeyAlgorithm;
        String hostKey;
        /** the secret cookie the WebView carries to the tunnel (SshTunnel): any other app on the phone lacks it */
        String gate;
        String auth;
        String importedKey;
        String importedPassphrase;

        String loopbackHost() {
            return android.net.Uri.parse(origin).getHost();
        }

        String label() {
            return user + "@" + host + (port == 22 ? "" : ":" + port);
        }

        JSONObject json() throws JSONException {
            return new JSONObject()
                .put("origin", origin)
                .put("host", host)
                .put("port", port)
                .put("user", user)
                .put("hostKeyAlgorithm", hostKeyAlgorithm)
                .put("hostKey", hostKey)
                .put("gate", gate)
                .put("auth", auth)
                .put("importedKey", importedKey == null ? "" : importedKey)
                .put("importedPassphrase", importedPassphrase == null ? "" : importedPassphrase);
        }

        static Pc of(JSONObject json) {
            Pc pc = new Pc();
            pc.origin = json.optString("origin");
            pc.host = json.optString("host");
            pc.port = json.optInt("port", 22);
            pc.user = json.optString("user");
            pc.hostKeyAlgorithm = json.optString("hostKeyAlgorithm");
            pc.hostKey = json.optString("hostKey");
            pc.gate = json.optString("gate");
            pc.auth = json.optString("auth", "phone-key");
            pc.importedKey = json.optString("importedKey", "");
            pc.importedPassphrase = json.optString("importedPassphrase", "");
            return pc;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject all(Context context) {
        try {
            return new JSONObject(prefs(context).getString("pcs", "{}"));
        } catch (JSONException damaged) {
            return new JSONObject();
        }
    }

    static Pc get(Context context, String origin) {
        if (origin == null) return null;
        JSONObject json = all(context).optJSONObject(origin);
        return json == null ? null : Pc.of(json);
    }

    static synchronized void put(Context context, Pc pc) throws JSONException {
        JSONObject pcs = all(context);
        pcs.put(pc.origin, pc.json());
        prefs(context).edit().putString("pcs", pcs.toString()).apply();
    }

    static synchronized void remove(Context context, String origin) {
        JSONObject pcs = all(context);
        pcs.remove(origin);
        prefs(context).edit().putString("pcs", pcs.toString()).apply();
    }

    static Pc find(Context context, String host, int port, String user) {
        JSONObject pcs = all(context);
        for (Iterator<String> keys = pcs.keys(); keys.hasNext(); ) {
            Pc pc = Pc.of(pcs.optJSONObject(keys.next()));
            if (pc.host.equalsIgnoreCase(host) && pc.port == port && pc.user.equals(user)) return pc;
        }
        return null;
    }

    /** A loopback origin no saved SSH PC uses: 127.0.0.2 upward (127.0.0.1 stays for whatever else runs on the phone). */
    static synchronized String freeOrigin(Context context) {
        JSONObject pcs = all(context);
        for (int n = 2; n < 255; n++) {
            String origin = "http://127.0.0." + n + ":" + LOCAL_PORT;
            if (!pcs.has(origin)) return origin;
        }
        throw new IllegalStateException("No loopback address is left for another SSH PC");
    }

    static String newGate() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    static List<Pc> list(Context context) {
        List<Pc> list = new ArrayList<>();
        JSONObject pcs = all(context);
        for (Iterator<String> keys = pcs.keys(); keys.hasNext(); ) list.add(Pc.of(pcs.optJSONObject(keys.next())));
        return list;
    }

    /**
     * This phone's own ed25519 key, made on first use. Its seed is sealed by SshVault; only the public
     * key ever leaves the app (shown to paste into authorized_keys, or added there after a password sign-in).
     */
    static synchronized KeyPair phoneKey(Context context) throws Exception {
        SharedPreferences prefs = prefs(context);
        String sealed = prefs.getString("phoneKeySeed", null);
        String pub = prefs.getString("phoneKeyPublic", null);
        if (sealed == null || pub == null) {
            KeyPair made = new Ed25519KeyPairGenerator().generateKeyPair();
            byte[] seed = ((Ed25519PrivateKey) made.getPrivate()).getSeed();
            byte[] raw = ((Ed25519PublicKey) made.getPublic()).getAbyte();
            sealed = SshVault.seal(seed);
            pub = Base64.encodeToString(raw, Base64.NO_WRAP);
            prefs.edit().putString("phoneKeySeed", sealed).putString("phoneKeyPublic", pub).commit();
        }
        return new KeyPair(new Ed25519PublicKey(Base64.decode(pub, Base64.NO_WRAP)), new Ed25519PrivateKey(SshVault.open(sealed)));
    }

    static String phoneKeyLine(Context context) throws Exception {
        KeyPair pair = phoneKey(context);
        byte[] blob = Ed25519Verify.get().encodePublicKey(pair.getPublic());
        String model = android.os.Build.MODEL == null ? "phone" : android.os.Build.MODEL.replaceAll("[^A-Za-z0-9._-]", "-");
        return "ssh-ed25519 " + Base64.encodeToString(blob, Base64.NO_WRAP) + " ovis-phone:" + model;
    }
}
