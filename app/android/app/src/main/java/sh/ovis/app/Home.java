package sh.ovis.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.regex.Pattern;

/**
 * Which screen the app starts an activity on, and what the hosted Connect a PC screen ("home") does while it is up:
 * the decisions alone, so MainActivity only carries them out (HomeTest; Home.swift is the iOS twin). Home is the hosted
 * app's front page opened as the WebView's first page without being the current PC; the app's own bundled page stands
 * in for it when it cannot load.
 */
final class Home {
    /** What an activity opens as its first page. */
    enum Screen {
        /** The current PC, at its own address. */
        PC,
        /** The hosted Connect a PC screen. */
        HOME,
        /** The app's own Connect a PC page (index.html): the fallback, what only it can take, or a build's first screen. */
        BUNDLED,
        /** The bundled demo. */
        DEMO
    }

    /** Where an activity that opened home is. */
    enum Phase {
        /** Home has not shown yet: its cover is up. */
        LOADING,
        SHOWN,
        /** Home was given up on: the activity is on its way out to the bundled page, and nothing moves it again. */
        FALLBACK,
        /** A relay PC's page came up in it: the hosted app is the current PC, and the rules of a PC's page decide. */
        PC
    }

    enum Event {
        /** Home's page is up (its client drew). */
        LOADED,
        /** A main-frame load failed, or answered with an HTTP error. */
        FAILED,
        /** Home took too long (timedOut). */
        TIMED_OUT,
        /** The WebView went to a relay PC's page (relayPc). */
        RELAY_PC
    }

    enum Action {
        NONE,
        LIFT_COVER,
        /** The bundled page instead, marked as the fallback for this process. */
        FALL_BACK,
        /** The hosted app becomes the current PC, which ends choosing. */
        KEEP_HOSTED
    }

    /** What the phone's Back does. */
    enum Back {
        /** A step back in the page's own history. */
        PAGE,
        /** The PC the screen was opened from to choose another. */
        CURRENT,
        /** Home again. */
        HOME,
        /** The system's Back: it leaves the app. */
        LEAVE
    }

    /** How long home may take to answer before the bundled page stands in. */
    static final long LOAD_MS = 8000;

    private Home() {}

    /**
     * The screen an activity starts on. `hosted`: the build's first screen is the hosted one (OVIS_APP_HOME); `pc`: a
     * PC is to open (none while the person chooses another); `demo`: the demo was asked for (HerdrShell openDemo);
     * `asked`: something waits that only the bundled page takes (an SSH setup, a pairing link, an SSH PC whose address
     * another app holds); `failed`: home did not load in this process and was not tried again since.
     */
    static Screen screen(boolean hosted, boolean pc, boolean demo, boolean asked, boolean failed) {
        if (asked && !pc) return Screen.BUNDLED;
        if (demo) return Screen.DEMO;
        if (pc) return Screen.PC;
        return hosted && !failed ? Screen.HOME : Screen.BUNDLED;
    }

    static Action on(Phase phase, Event event) {
        if (phase == Phase.FALLBACK || phase == Phase.PC) return Action.NONE;
        switch (event) {
            case LOADED: return phase == Phase.LOADING ? Action.LIFT_COVER : Action.NONE;
            case FAILED: return Action.FALL_BACK;
            case TIMED_OUT: return phase == Phase.LOADING ? Action.FALL_BACK : Action.NONE;
            case RELAY_PC: return Action.KEEP_HOSTED;
            default: return Action.NONE;
        }
    }

    static Phase after(Phase phase, Event event) {
        switch (on(phase, event)) {
            case LIFT_COVER: return Phase.SHOWN;
            case FALL_BACK: return Phase.FALLBACK;
            case KEEP_HOSTED: return Phase.PC;
            default: return phase;
        }
    }

    /**
     * Whether home took too long, `elapsedMs` after it started (time the app spent in front): LOAD_MS with no answer,
     * and as long as a PC gets to answer (PCStore.ANSWER_SECONDS) once its page is on its way, which a slow link needs.
     */
    static boolean timedOut(long elapsedMs, boolean answered) {
        return elapsedMs >= (answered ? PCStore.ANSWER_SECONDS * 1000L : LOAD_MS);
    }

    /**
     * What Back does on `screen`. `failed` as for screen(); `choosing`: the screen is up to choose another PC, with one
     * still current; `pageHasBack`: the page has a step of its own to take first. The bundled page while choosing goes
     * back to the PC at once, as it always did.
     */
    static Back back(Screen screen, boolean hosted, boolean failed, boolean choosing, boolean pageHasBack) {
        if (screen == Screen.BUNDLED && choosing) return Back.CURRENT;
        if (pageHasBack) return Back.PAGE;
        switch (screen) {
            case HOME: return choosing ? Back.CURRENT : Back.LEAVE;
            case DEMO: return Back.HOME;
            // home handed over to this page (an SSH setup, a pairing link): the fallback never goes back by itself
            case BUNDLED: return hosted && !failed ? Back.HOME : Back.LEAVE;
            default: return Back.LEAVE;
        }
    }

    private static final Pattern RELAY_PC = Pattern.compile("/s/[0-9a-f]{32}(/.*)?");

    /** Whether `url` is a page of a relay PC on the hosted app at `appOrigin`: within `/s/<server_id>/`, as a browser loads it. */
    static boolean relayPc(String url, String appOrigin) {
        if (url == null || appOrigin == null || !PCStore.sameOrigin(url, appOrigin)) return false;
        String path;
        try {
            path = new URI(url).getRawPath();
        } catch (URISyntaxException notAnAddress) {
            return false;
        }
        return path != null && PCStore.cleanPath(path) != null && RELAY_PC.matcher(path).matches();
    }

    /**
     * Whether `url` is what the word "demo" becomes in the hosted screen's address field (`https://demo/`): the bundled
     * demo, as that word opens it on the bundled page. No PC answers there: a one-word name has no certificate.
     */
    static boolean demoAddress(String url) {
        if (url == null) return false;
        try {
            URI uri = new URI(url);
            String path = uri.getRawPath();
            return "https".equalsIgnoreCase(uri.getScheme()) && "demo".equalsIgnoreCase(uri.getHost()) && uri.getPort() == -1
                && (path == null || path.isEmpty() || path.equals("/")) && uri.getRawQuery() == null && uri.getRawFragment() == null;
        } catch (URISyntaxException notAnAddress) {
            return false;
        }
    }
}
