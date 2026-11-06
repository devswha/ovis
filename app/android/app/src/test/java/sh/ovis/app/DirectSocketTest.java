package sh.ovis.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class DirectSocketTest {
    @Test
    public void opensOnlyAPrivateCarriersChannelAddress() {
        assertArrayEquals(new String[] { "192.168.0.10", "7319" }, DirectSocket.carrier("ws://192.168.0.10:7319/v1/ws?v=1"));
        assertArrayEquals(new String[] { "10.1.2.3", "40000" }, DirectSocket.carrier("ws://10.1.2.3:40000/v1/ws?v=1"));
        assertArrayEquals(new String[] { "172.31.0.1", "7319" }, DirectSocket.carrier("ws://172.31.0.1:7319/v1/ws?v=1"));
        assertArrayEquals(new String[] { "169.254.9.9", "7319" }, DirectSocket.carrier("ws://169.254.9.9:7319/v1/ws?v=1"));
        String[] refused = {
            null,
            "ws://8.8.8.8:7319/v1/ws?v=1",
            "ws://172.32.0.1:7319/v1/ws?v=1",
            "ws://127.0.0.1:7319/v1/ws?v=1",
            "ws://192.168.0.256:7319/v1/ws?v=1",
            "ws://192.168.00.1:7319/v1/ws?v=1",
            "ws://192.168.0.10:70000/v1/ws?v=1",
            "wss://192.168.0.10:7319/v1/ws?v=1",
            "ws://192.168.0.10/v1/ws?v=1",
            "ws://192.168.0.10:7319/v1/ws",
            "ws://192.168.0.10:7319/v1/ws?v=1&x=1",
            "ws://pc.local:7319/v1/ws?v=1",
        };
        for (String url : refused) assertNull(url, DirectSocket.carrier(url));
    }
}
