package sh.ovis.app.fork.assistant.overlay

import androidx.compose.ui.geometry.Offset

/**
 * Everything the overlay draws. The session owns this state and the overlay only renders it, so the UI can be
 * previewed and tuned without the assistant role.
 */
data class OverlayState(
    val phase: OverlayPhase = OverlayPhase.Opening,
    /** Smoothed microphone level, 0..1. Drives the waveform and the glow's breathing while listening. */
    val micLevel: Float = 0f,
    val call: CallStatus = CallStatus.Connecting,
    /** The assistant's voice, 0..1. Drives the waveform and the glow while it speaks. */
    val speakerLevel: Float = 0f,
    val muted: Boolean = false,
    /** Shown in the pill when something needs saying, such as "Can't reach the assistant". */
    val notice: String? = null,
    /** Where the glow starts, as a fraction of the window (x, y). Defaults to the side button on the right edge. */
    val glowOrigin: Offset = SIDE_BUTTON,
) {
    companion object {
        val SIDE_BUTTON = Offset(1f, 0.3f)
    }
}

enum class OverlayPhase {
    /** Entrance animation runs, then the overlay reports [OverlayAction.Opened]. */
    Opening,
    Open,
    /** Exit animation runs, then the overlay reports [OverlayAction.Closed] and the session finishes. */
    Closing,
}

/** What the call is doing, as the pill and the glow show it. */
enum class CallStatus {
    Connecting,
    Listening,
    Working,
    Speaking,
    /** A long task is running and the connection to OpenAI is closed; the voice comes back with the result. */
    Parked,
    Failed,
}

sealed interface OverlayAction {
    data object Opened : OverlayAction
    data object Closed : OverlayAction
    /** Tap outside or swipe down: the overlay closes and the call goes on in its notification. */
    data object Shrink : OverlayAction
    /** A tap on the parked pill: asks the assistant to bring the voice back now. */
    data object ResumeTapped : OverlayAction
}
