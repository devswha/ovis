package sh.ovis.app.fork.assistant.session

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import sh.ovis.app.fork.assistant.overlay.CallStatus
import sh.ovis.app.fork.assistant.overlay.OverlayPhase
import sh.ovis.app.fork.assistant.overlay.OverlayState

class CallOverlayTest {
    @Test fun parkedCallKeepsTheOverlayOpenAndShowsTheCallLevels() {
        val before = OverlayState(phase = OverlayPhase.Open)
        val playing = JSONObject().put("status", "live").put("phase", "parked")
            .put("muted", true).put("input", 0.0).put("output", 0.25)
        assertEquals(before.copy(call = CallStatus.Parked, muted = true, speakerLevel = 0.25f), before.showing(playing))
    }

    @Test fun aFailureCanStayVisibleForTheNextPressToRetry() {
        val call = JSONObject().put("status", "ended").put("notice", "Pi did not answer")
        assertEquals(CallStatus.Failed, OverlayState().showing(call).call)
        assertEquals("Pi did not answer", OverlayState().showing(call).notice)
    }
}
