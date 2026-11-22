package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import sh.ovis.app.Home.Action;
import sh.ovis.app.Home.Back;
import sh.ovis.app.Home.Event;
import sh.ovis.app.Home.Phase;
import sh.ovis.app.Home.Screen;

public class HomeTest {
    private static final boolean HOSTED = true, BUNDLED_BUILD = false;

    @Test
    public void aSavedPcOpensDirectlyWhateverElseHolds() {
        assertEquals(Screen.PC, Home.screen(HOSTED, true, false, false, false));
        assertEquals(Screen.PC, Home.screen(HOSTED, true, false, false, true));
        // an SSH PC's failure left over from an earlier open is no reason to keep another PC from opening
        assertEquals(Screen.PC, Home.screen(HOSTED, true, false, true, false));
        assertEquals(Screen.PC, Home.screen(BUNDLED_BUILD, true, false, false, false));
    }

    @Test
    public void withNoPcToOpenTheHostedScreenIsHome() {
        // first launch, after Forget or disconnect, and choosing another PC (the caller passes no PC while choosing)
        assertEquals(Screen.HOME, Home.screen(HOSTED, false, false, false, false));
    }

    @Test
    public void theBundledPageStandsInOnceHomeFailedUntilItIsTriedAgain() {
        assertEquals(Screen.BUNDLED, Home.screen(HOSTED, false, false, false, true));
    }

    @Test
    public void theBundledPageTakesWhatOnlyItCanTake() {
        // an SSH setup a page asked for, a pairing link parked for it, an SSH PC it has to say could not open
        assertEquals(Screen.BUNDLED, Home.screen(HOSTED, false, false, true, false));
        assertEquals(Screen.BUNDLED, Home.screen(HOSTED, false, false, true, true));
    }

    @Test
    public void theDemoAskedForOpensOverAnythingElse() {
        assertEquals(Screen.DEMO, Home.screen(HOSTED, false, true, false, false));
        assertEquals(Screen.DEMO, Home.screen(HOSTED, true, true, false, false));
        assertEquals(Screen.DEMO, Home.screen(HOSTED, false, true, false, true));
        assertEquals(Screen.DEMO, Home.screen(BUNDLED_BUILD, false, true, false, false));
    }

    @Test
    public void whatOnlyTheBundledPageCanTakeComesBeforeTheDemo() {
        // a pairing link that arrives while the demo is up waits for the connect screen, as it does over a PC's page
        assertEquals(Screen.BUNDLED, Home.screen(HOSTED, false, true, true, false));
    }

    @Test
    public void aBuildWithTheBundledFirstScreenNeverOpensHome() {
        for (boolean asked : new boolean[] { false, true }) {
            for (boolean failed : new boolean[] { false, true }) {
                assertEquals(Screen.BUNDLED, Home.screen(BUNDLED_BUILD, false, false, asked, failed));
            }
        }
    }

    @Test
    public void homeThatLoadsLiftsItsCoverOnce() {
        assertEquals(Action.LIFT_COVER, Home.on(Phase.LOADING, Event.LOADED));
        assertEquals(Phase.SHOWN, Home.after(Phase.LOADING, Event.LOADED));
        assertEquals(Action.NONE, Home.on(Phase.SHOWN, Event.LOADED));
        assertEquals(Phase.SHOWN, Home.after(Phase.SHOWN, Event.LOADED));
    }

    @Test
    public void homeThatFailsOrTakesTooLongGivesWayToTheBundledPage() {
        assertEquals(Action.FALL_BACK, Home.on(Phase.LOADING, Event.FAILED));
        assertEquals(Action.FALL_BACK, Home.on(Phase.LOADING, Event.TIMED_OUT));
        assertEquals(Phase.FALLBACK, Home.after(Phase.LOADING, Event.FAILED));
        assertEquals(Phase.FALLBACK, Home.after(Phase.LOADING, Event.TIMED_OUT));
    }

    @Test
    public void aPageOfHomeThatFailsLaterGivesWayTooButTheClockNoLongerCounts() {
        // a PC's row pressed with the network gone: the page left behind is no screen to stay on
        assertEquals(Action.FALL_BACK, Home.on(Phase.SHOWN, Event.FAILED));
        assertEquals(Phase.FALLBACK, Home.after(Phase.SHOWN, Event.FAILED));
        assertEquals(Action.NONE, Home.on(Phase.SHOWN, Event.TIMED_OUT));
        assertEquals(Phase.SHOWN, Home.after(Phase.SHOWN, Event.TIMED_OUT));
    }

    @Test
    public void nothingThatComesAfterTheFallbackMovesThePersonAgain() {
        // a load that still finishes, fails once more or runs into the clock: the bundled page is up, with what was typed
        for (Event event : Event.values()) {
            assertEquals(event.name(), Action.NONE, Home.on(Phase.FALLBACK, event));
            assertEquals(event.name(), Phase.FALLBACK, Home.after(Phase.FALLBACK, event));
        }
    }

    @Test
    public void arrivingAtARelayPcMakesTheHostedAppThePc() {
        for (Phase phase : new Phase[] { Phase.LOADING, Phase.SHOWN }) {
            assertEquals(phase.name(), Action.KEEP_HOSTED, Home.on(phase, Event.RELAY_PC));
            assertEquals(phase.name(), Phase.PC, Home.after(phase, Event.RELAY_PC));
        }
    }

    @Test
    public void onceARelayPcIsUpThePcsOwnRulesDecide() {
        for (Event event : Event.values()) {
            assertEquals(event.name(), Action.NONE, Home.on(Phase.PC, event));
            assertEquals(event.name(), Phase.PC, Home.after(Phase.PC, event));
        }
    }

    @Test
    public void theClockRunsOutAtEightSecondsWithNoAnswer() {
        assertEquals(false, Home.timedOut(7999, false));
        assertEquals(true, Home.timedOut(8000, false));
    }

    @Test
    public void aPageThatAnsweredGetsAsLongAsAPcDoesToAnswer() {
        // the hosted page is on its way over a slow link: cut off at eight seconds, its script would never finish arriving
        assertEquals(false, Home.timedOut(8000, true));
        assertEquals(false, Home.timedOut(PCStore.ANSWER_SECONDS * 1000L - 1, true));
        assertEquals(true, Home.timedOut(PCStore.ANSWER_SECONDS * 1000L, true));
    }

    @Test
    public void backGoesThroughThePagesOwnHistoryFirstAtHome() {
        assertEquals(Back.PAGE, Home.back(Screen.HOME, HOSTED, false, true, true));
        assertEquals(Back.PAGE, Home.back(Screen.HOME, HOSTED, false, false, true));
        assertEquals(Back.PAGE, Home.back(Screen.PC, HOSTED, false, false, true));
        assertEquals(Back.PAGE, Home.back(Screen.DEMO, HOSTED, false, false, true));
    }

    @Test
    public void backAtHomeWithNothingBehindReturnsToThePcItWasOpenedFrom() {
        assertEquals(Back.CURRENT, Home.back(Screen.HOME, HOSTED, false, true, false));
        // no PC to go back to: the system's Back, which leaves the app
        assertEquals(Back.LEAVE, Home.back(Screen.HOME, HOSTED, false, false, false));
    }

    @Test
    public void backOnTheBundledPageWhileChoosingReturnsToThePcAtOnceAsBefore() {
        for (boolean hosted : new boolean[] { HOSTED, BUNDLED_BUILD }) {
            for (boolean failed : new boolean[] { false, true }) {
                for (boolean pageHasBack : new boolean[] { false, true }) {
                    assertEquals(Back.CURRENT, Home.back(Screen.BUNDLED, hosted, failed, true, pageHasBack));
                }
            }
        }
    }

    @Test
    public void backOnTheFallbackLeavesTheAppRatherThanTryHomeAgain() {
        assertEquals(Back.LEAVE, Home.back(Screen.BUNDLED, HOSTED, true, false, false));
        assertEquals(Back.PAGE, Home.back(Screen.BUNDLED, HOSTED, true, false, true));
    }

    @Test
    public void backOnTheBundledPageHomeHandedOverToReturnsHome() {
        // the SSH setup or a pairing link took the person off home: Back is the way back to it
        assertEquals(Back.HOME, Home.back(Screen.BUNDLED, HOSTED, false, false, false));
        assertEquals(Back.PAGE, Home.back(Screen.BUNDLED, HOSTED, false, false, true));
    }

    @Test
    public void backOnTheBundledFirstScreenLeavesTheAppAsBefore() {
        assertEquals(Back.LEAVE, Home.back(Screen.BUNDLED, BUNDLED_BUILD, false, false, false));
        assertEquals(Back.PAGE, Home.back(Screen.BUNDLED, BUNDLED_BUILD, false, false, true));
    }

    @Test
    public void backFromTheDemoReturnsToWhereItWasOpenedFrom() {
        // the demo is the web view's first page, with nothing behind it: home again (the caller keeps choosing as it was)
        assertEquals(Back.HOME, Home.back(Screen.DEMO, HOSTED, false, false, false));
        assertEquals(Back.HOME, Home.back(Screen.DEMO, HOSTED, false, true, false));
        assertEquals(Back.HOME, Home.back(Screen.DEMO, BUNDLED_BUILD, false, false, false));
    }

    @Test
    public void backOnAPcWithNothingBehindLeavesTheApp() {
        assertEquals(Back.LEAVE, Home.back(Screen.PC, HOSTED, false, false, false));
        assertEquals(Back.LEAVE, Home.back(Screen.PC, HOSTED, false, true, false));
    }

    private static final String APP = "https://app.ovis.sh";
    private static final String ID = "0123456789abcdef0123456789abcdef";

    @Test
    public void aRelayPcsPageIsAnyPageWithinAScopeOfTheHostedApp() {
        for (String page : new String[] {
            APP + "/s/" + ID + "/",
            APP + "/s/" + ID,
            APP + "/s/" + ID + "/#offer=eyJ2IjoxfQ",
            APP + "/s/" + ID + "/?pane=w1%3Ap1",
            APP + "/s/" + ID + "/index.html",
            "https://APP.ovis.sh:443/s/" + ID + "/",
        }) assertTrue(page, Home.relayPc(page, APP));
    }

    @Test
    public void theHostedAppsOwnPagesAndOtherOriginsAreNoRelayPc() {
        for (String page : new String[] {
            APP + "/",
            APP + "/#pcs",
            APP + "/#add",
            APP + "/s/",
            APP + "/s/not-a-pc/",
            APP + "/s/" + ID + "0/",
            APP + "/sx/" + ID + "/",
            APP + "/x/s/" + ID + "/",
            APP + "/s/" + ID + "/../" + ID + "/",
            APP + "/s/" + ID + "/%2e%2e/x",
            APP + "/s/" + ID.toUpperCase(java.util.Locale.ROOT) + "/",
            "http://app.ovis.sh/s/" + ID + "/",
            "https://app.ovis.sh:8443/s/" + ID + "/",
            "https://app.ovis.sh.evil.example/s/" + ID + "/",
            "https://localhost/s/" + ID + "/",
            "about:blank",
            "",
        }) assertFalse(page, Home.relayPc(page, APP));
        assertFalse(Home.relayPc(null, APP));
        assertFalse(Home.relayPc(APP + "/s/" + ID + "/", null));
        // a build for another hosted origin takes that origin and not the store's
        String preview = "https://relay-0510.ovis-app.pages.dev";
        assertTrue(Home.relayPc(preview + "/s/" + ID + "/", preview));
        assertFalse(Home.relayPc(APP + "/s/" + ID + "/", preview));
    }

    @Test
    public void theAddressDemoTypedIntoTheHostedScreenIsTheBundledDemo() {
        // the hosted screen reads a bare word as an https name: what "demo" becomes there, and nothing else
        for (String typed : new String[] { "https://demo", "https://demo/", "https://DEMO/" }) assertTrue(typed, Home.demoAddress(typed));
        for (String other : new String[] {
            "http://demo/", "https://demo:7317/", "https://demo/x", "https://demo/?pair=123456", "https://demo/#offer=x",
            "https://demo.example.com/", "https://my-demo/", "https://demo.ts.net/", "demo", "", "https://",
        }) assertFalse(other, Home.demoAddress(other));
        assertFalse(Home.demoAddress(null));
    }
}
