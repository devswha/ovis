package sh.ovis.app;

/**
 * What MainActivity's cover says while a PC opens, from what has arrived and when. Only an address
 * from which nothing at all arrived gives up on its own (NO_ANSWER, after the answer limit): a slow
 * link that answers keeps loading as long as bytes come, and one that stops sending is told so
 * (STALLED), with Keep waiting, rather than called off. Times are in milliseconds on any one clock
 * (SystemClock.elapsedRealtime in the app); byte counts are the app's received total
 * (TrafficStats), which grows with anything the WebView receives, or a negative number where the
 * phone cannot count them.
 */
final class OpeningWatch {
    enum Stage {
        /** Nothing to say yet: "Opening …". */
        OPENING,
        /** The PC answered, or bytes arrive, and the page still has not shown: a slow link. */
        SLOW,
        /** It answered, then nothing arrived for STALL_MS. */
        STALLED,
        /** Nothing at all arrived within the answer limit: the error page. */
        NO_ANSWER
    }

    /** How long a first page may take before the cover calls the link slow. */
    static final long SLOW_AFTER_MS = 5000;

    /** How long nothing may arrive, once something has, before the cover says the link stalled. */
    static final long STALL_MS = 20000;

    /**
     * What must arrive before it counts as an answer without the page's own: a TLS handshake or an
     * HTTP answer is more, while a server that accepts the connection and never sends gives the app
     * only TCP's own packets, a few hundred bytes at most.
     */
    static final long FIRST_BYTES = 1024;

    private final long startedAt;
    private final long answerLimitMs;
    private final long baseBytes;
    private long lastBytes;
    private boolean answered;
    private boolean arrived;
    private long lastProgressAt;

    /** An open that started at `now`, given `answerLimitMs` to answer, with `bytes` received so far. */
    OpeningWatch(long now, long answerLimitMs, long bytes) {
        this.startedAt = now;
        this.answerLimitMs = answerLimitMs;
        this.baseBytes = bytes;
        this.lastBytes = bytes;
        this.lastProgressAt = now;
    }

    /** The PC answered the first page: its response committed in the WebView. */
    void answered(long now) {
        answered = true;
        arrived = true;
        lastProgressAt = now;
    }

    /** The app's received total is `bytes` at `now`: more than before is progress. */
    void received(long now, long bytes) {
        if (bytes < 0 || baseBytes < 0 || bytes <= lastBytes) return;
        lastBytes = bytes;
        if (!arrived && bytes - baseBytes < FIRST_BYTES) return;
        arrived = true;
        lastProgressAt = now;
    }

    /** Keep waiting on a stalled open: the stall is counted again from `now`. */
    void keepWaiting(long now) {
        lastProgressAt = now;
    }

    /** Bytes received since the open started, 0 where the phone cannot count them. */
    long bytesSoFar() {
        return baseBytes < 0 ? 0 : lastBytes - baseBytes;
    }

    boolean hasAnswered() {
        return answered;
    }

    Stage stage(long now) {
        if (!arrived) return now - startedAt >= answerLimitMs ? Stage.NO_ANSWER : Stage.OPENING;
        if (now - lastProgressAt >= STALL_MS) return Stage.STALLED;
        return now - startedAt >= SLOW_AFTER_MS ? Stage.SLOW : Stage.OPENING;
    }
}
