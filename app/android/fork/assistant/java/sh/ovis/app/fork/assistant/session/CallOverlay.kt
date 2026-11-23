package sh.ovis.app.fork.assistant.session

import org.json.JSONObject
import sh.ovis.app.fork.assistant.overlay.CallStatus
import sh.ovis.app.fork.assistant.overlay.OverlayState

/** The call's presentation, not its wire frames. Keep the animation phase owned by the overlay. */
internal fun OverlayState.showing(snapshot: JSONObject): OverlayState = copy(
    call = if (snapshot.optString("status") == "ended") CallStatus.Failed else when (snapshot.optString("phase")) {
        "parked" -> CallStatus.Parked
        "speaking" -> CallStatus.Speaking
        "working" -> CallStatus.Working
        "listening", "standby", "muted" -> CallStatus.Listening
        else -> CallStatus.Connecting
    },
    muted = snapshot.optBoolean("muted"),
    micLevel = snapshot.optDouble("input", 0.0).toFloat(),
    speakerLevel = snapshot.optDouble("output", 0.0).toFloat(),
    notice = snapshot.optString("notice").takeIf { it.isNotEmpty() },
)
