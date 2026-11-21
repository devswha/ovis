package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

public class LanPcsTest {
    @Test
    public void listsOnlyPrivateAddressesOnThisWifi() {
        for (String host : new String[] { "192.168.0.12", "10.1.2.3", "172.16.0.1", "172.31.255.254", "169.254.3.4" }) {
            assertTrue(host, LanPcs.lanHost(host));
        }
        for (String host : new String[] { "100.101.102.103", "100.64.0.1", "8.8.8.8", "127.0.0.1", "172.32.0.1", "192.169.0.1",
                "256.1.1.1", "fd12::1", "fe80::1", "pc.local", "", null }) {
            assertFalse(String.valueOf(host), LanPcs.lanHost(host));
        }
    }

    @Test
    public void asksOnlyTheOfferOfAnAddressOnThisWifi() {
        assertEquals("http://192.168.0.12:7319/v1/offer", LanPcs.offerUrl("192.168.0.12", 7319));
        assertNull(LanPcs.offerUrl("100.101.102.103", 7319));
        assertNull(LanPcs.offerUrl("192.168.0.12", 0));
        assertNull(LanPcs.offerUrl("192.168.0.12", 65536));
        assertNull(LanPcs.readOffer("8.8.8.8", 80));
    }

    @Test
    public void readsAnOfferUpToItsLimitAndNothingPastIt() throws IOException {
        String offer = "{\"v\":1,\"server_id\":\"0123456789abcdef0123456789abcdef\"}";
        assertEquals(offer, LanPcs.readCapped(new ByteArrayInputStream(offer.getBytes(StandardCharsets.UTF_8))));
        byte[] large = new byte[LanPcs.MAX_OFFER_BYTES + 1];
        Arrays.fill(large, (byte) 'a');
        assertNull(LanPcs.readCapped(new ByteArrayInputStream(large)));
    }

    @Test
    public void showsTheNameAPcAdvertised() {
        assertEquals("Studio PC", LanPcs.shownName("Studio\\032PC"));
        assertEquals("", LanPcs.shownName(null));
    }
}
