package sh.ovis.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class OvisAuthReturnTest {
    private static final String STATE = "s7Hq-2xK_9pL";

    @Test
    public void aSuccessInTheFragmentEndsTheWait() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=" + STATE, STATE));
    }

    @Test
    public void aDenialInTheFragmentEndsTheWait() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback#error=access_denied&state=" + STATE, STATE));
    }

    @Test
    public void aSuccessInTheQueryFromAnOlderServiceEndsTheWait() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback?code=c0de&state=" + STATE, STATE));
    }

    @Test
    public void anotherSignInsStateIsLeftWaiting() {
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=other", STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback?error=access_denied&state=other", STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=other?state=" + STATE, STATE));
    }

    @Test
    public void anotherAddressIsIgnored() {
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/elsewhere#code=c0de&state=" + STATE, STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://other/callback#code=c0de&state=" + STATE, STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("https://account/callback#code=c0de&state=" + STATE, STATE));
    }

    @Test
    public void aReturnWithNeitherCodeNorErrorIsIgnored() {
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#state=" + STATE, STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=" + STATE, null));
    }
}
