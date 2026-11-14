package sh.ovis.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Seals the SSH secrets the app keeps (its own private key's seed, an imported private key and its
 * passphrase) with an AES-GCM key that lives in the Android Keystore and never leaves it. A sealed
 * value is only usable on this phone, by this app: a backup or a copy of the app's files holds
 * nothing that signs in anywhere.
 */
final class SshVault {
    private static final String ALIAS = "ovis-ssh-vault";

    private SshVault() {}

    private static synchronized SecretKey key() throws GeneralSecurityException, java.io.IOException {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    static String seal(byte[] plain) throws GeneralSecurityException, java.io.IOException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] sealed = cipher.doFinal(plain);
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
    }

    static String sealText(String plain) throws GeneralSecurityException, java.io.IOException {
        return seal(plain.getBytes(StandardCharsets.UTF_8));
    }

    static byte[] open(String sealed) throws GeneralSecurityException, java.io.IOException {
        int colon = sealed.indexOf(':');
        if (colon < 0) throw new GeneralSecurityException("damaged sealed value");
        byte[] iv = Base64.decode(sealed.substring(0, colon), Base64.NO_WRAP);
        byte[] body = Base64.decode(sealed.substring(colon + 1), Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return cipher.doFinal(body);
    }

    static String openText(String sealed) throws GeneralSecurityException, java.io.IOException {
        return new String(open(sealed), StandardCharsets.UTF_8);
    }
}
