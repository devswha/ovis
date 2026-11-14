package sh.ovis.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class OpeningWatchTest {
    private static final long LIMIT = 20000;

    @Test
    public void givesUpOnlyWhenNothingArrivedWithinTheLimit() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 5000);
        watch.received(10000, 5000);
        assertEquals(OpeningWatch.Stage.OPENING, watch.stage(19999));
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(20000));
    }

    @Test
    public void tcpPacketsAloneAreNoAnswer() {
        // a server that accepts the connection and never sends: only TCP's own packets arrive
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 5000);
        watch.received(300, 5000 + 120);
        watch.received(15000, 5000 + 300);
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(20000));
    }

    @Test
    public void aSlowLinkThatKeepsSendingIsNeverCutOff() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 0);
        assertEquals(OpeningWatch.Stage.OPENING, watch.stage(1000));
        watch.answered(1300);
        assertEquals(OpeningWatch.Stage.OPENING, watch.stage(4999));
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(5000));
        // 10 KB a second for five minutes
        for (long at = 5000; at <= 300000; at += 1000) {
            watch.received(at, at * 10);
            assertEquals(OpeningWatch.Stage.SLOW, watch.stage(at + 999));
        }
        assertEquals(3000000, watch.bytesSoFar());
    }

    @Test
    public void bytesWithoutThePagesAnswerCountAsAnAnswer() {
        // a TLS handshake over a slow VPN: bytes come before the page's response
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 100);
        watch.received(8000, 100 + OpeningWatch.FIRST_BYTES);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(25000));
    }

    @Test
    public void saysStalledAfterNothingMoreArrivedAndKeepWaitingCountsAgain() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 0);
        watch.answered(2000);
        watch.received(6000, 50000);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(6000 + OpeningWatch.STALL_MS - 1));
        assertEquals(OpeningWatch.Stage.STALLED, watch.stage(6000 + OpeningWatch.STALL_MS));
        watch.keepWaiting(30000);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(30000 + OpeningWatch.STALL_MS - 1));
        watch.received(40000, 60000);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(40000 + OpeningWatch.STALL_MS - 1));
    }

    @Test
    public void withoutAByteCountTheAnswerAloneDecides() {
        // TrafficStats.UNSUPPORTED (-1): no bytes are ever counted
        OpeningWatch watch = new OpeningWatch(0, LIMIT, -1);
        watch.received(3000, -1);
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(LIMIT));

        OpeningWatch answered = new OpeningWatch(0, LIMIT, -1);
        answered.answered(3000);
        assertEquals(OpeningWatch.Stage.SLOW, answered.stage(LIMIT));
        assertEquals(0, answered.bytesSoFar());
    }

    @Test
    public void aShorterLimitFromTheConnectScreenHolds() {
        // the connect screen's check used most of the limit: the cover gets what is left
        OpeningWatch watch = new OpeningWatch(0, PCStore.PAGE_FLOOR_MS, 0);
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(PCStore.PAGE_FLOOR_MS));
    }
}
