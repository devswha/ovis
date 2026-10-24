package sh.ovis.push;

import static org.junit.Assert.*;

import android.content.SharedPreferences;
import java.security.GeneralSecurityException;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

public class PushStoreTest {
    /** String preferences with atomic commits, the surface PushStore actually uses. */
    private static final class MemoryPreferences implements SharedPreferences {
        final Map<String, String> values = new HashMap<>();
        int commits;
        boolean writable = true;

        @Override public String getString(String key, String fallback) { return values.getOrDefault(key, fallback); }
        @Override public Map<String, ?> getAll() { return new HashMap<>(values); }
        @Override public boolean contains(String key) { return values.containsKey(key); }
        @Override public Editor edit() {
            return new Editor() {
                final Map<String, String> next = new HashMap<>(values);
                @Override public Editor putString(String key, String value) { next.put(key, value); return this; }
                @Override public Editor remove(String key) { next.remove(key); return this; }
                @Override public Editor clear() { next.clear(); return this; }
                @Override public boolean commit() {
                    values.clear();
                    values.putAll(next);
                    if (!writable) return false;
                    commits++;
                    return true;
                }
                @Override public void apply() { commit(); }
                @Override public Editor putStringSet(String k, Set<String> v) { throw new UnsupportedOperationException(); }
                @Override public Editor putInt(String k, int v) { throw new UnsupportedOperationException(); }
                @Override public Editor putLong(String k, long v) { throw new UnsupportedOperationException(); }
                @Override public Editor putFloat(String k, float v) { throw new UnsupportedOperationException(); }
                @Override public Editor putBoolean(String k, boolean v) { throw new UnsupportedOperationException(); }
            };
        }
        @Override public Set<String> getStringSet(String k, Set<String> v) { throw new UnsupportedOperationException(); }
        @Override public int getInt(String k, int v) { throw new UnsupportedOperationException(); }
        @Override public long getLong(String k, long v) { throw new UnsupportedOperationException(); }
        @Override public float getFloat(String k, float v) { throw new UnsupportedOperationException(); }
        @Override public boolean getBoolean(String k, boolean v) { throw new UnsupportedOperationException(); }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
    }

    private static MemoryPreferences stored(PushKeys keys) {
        MemoryPreferences prefs = new MemoryPreferences();
        Base64.Encoder encoder = Base64.getEncoder();
        prefs.values.put("private", encoder.encodeToString(keys.privateScalar));
        prefs.values.put("public", encoder.encodeToString(keys.publicPoint));
        prefs.values.put("auth", encoder.encodeToString(keys.auth));
        prefs.values.put("endpoints", "{\"pc1\":{},\"pc2\":{}}");
        return prefs;
    }

    @Test public void keepsHealthyKeys() throws GeneralSecurityException {
        PushKeys original = PushKeys.generate();
        MemoryPreferences prefs = stored(original);
        PushKeys reused = PushStore.getOrCreate(prefs);
        assertArrayEquals(original.publicPoint, reused.publicPoint);
        assertArrayEquals(original.auth, reused.auth);
        assertEquals(0, prefs.commits);
    }

    @Test public void createsMissingKeys() throws GeneralSecurityException {
        MemoryPreferences prefs = new MemoryPreferences();
        PushKeys keys = PushStore.getOrCreate(prefs);
        assertArrayEquals(keys.publicPoint, PushStore.read(prefs).publicPoint);
        assertEquals(1, prefs.commits);
    }

    @Test public void repairsMalformedBase64() throws GeneralSecurityException {
        MemoryPreferences prefs = stored(PushKeys.generate());
        prefs.values.put("private", "!");
        PushKeys repaired = PushStore.getOrCreate(prefs);
        assertArrayEquals(repaired.publicPoint, PushStore.read(prefs).publicPoint);
        assertEquals("{\"pc1\":{},\"pc2\":{}}", prefs.values.get("endpoints"));
        assertEquals(1, prefs.commits);
    }

    @Test public void repairsWrongLength() throws GeneralSecurityException {
        MemoryPreferences prefs = stored(PushKeys.generate());
        prefs.values.put("auth", "AQ==");
        PushKeys repaired = PushStore.getOrCreate(prefs);
        assertArrayEquals(repaired.auth, PushStore.read(prefs).auth);
        assertEquals(16, repaired.auth.length);
    }

    @Test public void repairsPartialKeys() throws GeneralSecurityException {
        MemoryPreferences prefs = stored(PushKeys.generate());
        prefs.values.remove("public");
        PushKeys repaired = PushStore.getOrCreate(prefs);
        assertArrayEquals(repaired.publicPoint, PushStore.read(prefs).publicPoint);
        assertEquals(1, prefs.commits);
    }

    @Test public void repairsInvalidScalar() throws GeneralSecurityException {
        MemoryPreferences prefs = stored(PushKeys.generate());
        prefs.values.put("private", Base64.getEncoder().encodeToString(new byte[32]));
        PushKeys repaired = PushStore.getOrCreate(prefs);
        assertArrayEquals(repaired.publicPoint, PushStore.read(prefs).publicPoint);
    }

    @Test public void repairsMismatchedHalves() throws GeneralSecurityException {
        PushKeys original = PushKeys.generate();
        MemoryPreferences prefs = stored(original);
        prefs.values.put("public", Base64.getEncoder().encodeToString(PushKeys.generate().publicPoint));
        PushKeys repaired = PushStore.getOrCreate(prefs);
        assertFalse(java.util.Arrays.equals(original.publicPoint, repaired.publicPoint));
        assertFalse(java.util.Arrays.equals(original.auth, repaired.auth));
        assertArrayEquals(repaired.publicPoint, PushStore.read(prefs).publicPoint);
    }

    @Test public void readDoesNotRepairDamage() throws GeneralSecurityException {
        MemoryPreferences prefs = stored(PushKeys.generate());
        prefs.values.put("private", "!");
        assertThrows(PushKeys.Damaged.class, () -> PushStore.read(prefs));
        assertEquals("!", prefs.values.get("private"));
        assertEquals(0, prefs.commits);
    }

    @Test public void failedSaveDoesNotReturnUnstoredKeys() throws GeneralSecurityException {
        MemoryPreferences prefs = new MemoryPreferences();
        prefs.writable = false;
        assertThrows(GeneralSecurityException.class, () -> PushStore.getOrCreate(prefs));
        assertNull(PushStore.read(prefs));
        assertEquals(0, prefs.commits);
    }
}
