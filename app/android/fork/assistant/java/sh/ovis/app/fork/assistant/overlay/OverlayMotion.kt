package sh.ovis.app.fork.assistant.overlay

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Stable
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** One animated property's timing, in milliseconds from the start of the sequence. */
internal data class Segment(val delay: Int, val duration: Int, val easing: Easing) {
    fun <T> spec(): FiniteAnimationSpec<T> = tween(duration, delay, easing)
}

internal enum class Track { Shadow, Glow, Bloom, Pill }

/**
 * Durations, delays and easings, fitted to Gemini's opening (60 fps recording; 0 is when the shadow starts).
 * Closing is quicker: the pill drops and fade while the shadow and glow fade out.
 */
internal object OverlayMotion {
    val SlowEnd = CubicBezierEasing(0f, 0f, 0.2f, 1f)
    private val Emphasized = CubicBezierEasing(0.3f, 0f, 0f, 1f)
    private val Travel = CubicBezierEasing(0.2f, 0f, 0.1f, 1f)
    private val Accelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)

    val Opening = mapOf(
        Track.Shadow to Segment(delay = 0, duration = 420, easing = LinearEasing),
        Track.Glow to Segment(delay = 80, duration = 700, easing = Travel),
        Track.Bloom to Segment(delay = 120, duration = 620, easing = SlowEnd),
        Track.Pill to Segment(delay = 70, duration = 220, easing = Emphasized),
    )

    val Closing = mapOf(
        Track.Shadow to Segment(delay = 60, duration = 220, easing = LinearEasing),
        Track.Glow to Segment(delay = 30, duration = 240, easing = Accelerate),
        Track.Bloom to Segment(delay = 30, duration = 200, easing = Accelerate),
        Track.Pill to Segment(delay = 20, duration = 160, easing = Accelerate),
    )

    /** The pill grows from its centre, blurred and see-through, and is sharp before it has finished growing. */
    const val PillScaleFrom = 0.25f
    const val PillOpaqueAt = 0.5f
    const val PillSharpAt = 0.7f
    val PillBlurFrom = 14.dp

    /** On the way out the pill sinks and fades instead of shrinking. */
    val Drop = 14.dp
    const val DropScale = 0.95f
}

/** The progress (0 = hidden, 1 = shown) of each part of the overlay, played as [OverlayMotion] describes. */
@Stable
internal class OverlayProgress(open: Boolean) {
    private val values = Track.entries.associateWith { Animatable(if (open) 1f else 0f) }

    operator fun get(track: Track): Float = values.getValue(track).value

    /** Plays the opening or closing from wherever each part is now, and returns once all of them have settled. */
    suspend fun play(opening: Boolean) = coroutineScope {
        val segments = if (opening) OverlayMotion.Opening else OverlayMotion.Closing
        val target = if (opening) 1f else 0f
        values.forEach { (track, value) -> launch { value.animateTo(target, segments.getValue(track).spec()) } }
    }

    suspend fun snapTo(open: Boolean) {
        val target = if (open) 1f else 0f
        values.values.forEach { it.snapTo(target) }
    }
}
