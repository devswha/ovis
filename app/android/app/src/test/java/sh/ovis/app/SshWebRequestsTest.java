package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class SshWebRequestsTest {
    @Test
    public void blocksSubresourcesOnOtherPortsBeforeTheyCanSendTheTunnelCookie() {
        // Neither a main-frame navigation nor an API fetch is needed to send the cookie.
        assertEquals(Integer.valueOf(403), SshWebRequests.blocked("http://127.0.0.2:8080/logo.png", code -> code));
        assertNull(SshWebRequests.blocked("http://127.0.0.2:" + SshPcs.LOCAL_PORT + "/logo.png", code -> code));
    }
}
