package sh.ovis.app.fork.assistant.overlay

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.sqrt

private const val Bars = 11
private val Pitch = 10.2.dp
private val BarWidth = 2.2.dp
private val MaxHeight = 25.5.dp

/** How tall each bar can get, by distance from the middle bar: a bell, so the outer bars stay dots. */
private val Envelope = floatArrayOf(1f, 0.85f, 0.62f, 0.4f, 0.22f, 0.1f)
private const val SampleSeconds = 0.06f
private const val EaseSeconds = 0.05f

/** Dots that grow into bars with the mic level. A word travels from the middle bar out to the edges. */
@Composable
internal fun DottedWaveform(micLevel: Float, modifier: Modifier = Modifier) {
    val heights = rememberBarHeights(micLevel)
    Canvas(modifier.size(width = Pitch * (Bars - 1) + BarWidth, height = MaxHeight)) {
        val width = BarWidth.toPx()
        repeat(Bars) { bar ->
            val height = width + (size.height - width) * heights[abs(bar - Bars / 2)].coerceIn(0f, 1f)
            drawRoundRect(
                color = OverlayColors.Content,
                topLeft = Offset(bar * Pitch.toPx(), (size.height - height) / 2),
                size = Size(width, height),
                cornerRadius = CornerRadius(width / 2),
            )
        }
    }
}

/**
 * How full each bar is (0..1), counted from the middle one outward. The newest level goes in the middle and older
 * ones move out; each bar eases toward its target every frame.
 */
@Composable
private fun rememberBarHeights(micLevel: Float): List<Float> {
    val level by rememberUpdatedState(micLevel)
    val shown = remember { mutableStateListOf(*Array(Envelope.size) { 0f }) }
    LaunchedEffect(Unit) {
        val history = FloatArray(Envelope.size)
        var last = withFrameNanos { it }
        var sinceSample = 0f
        while (true) {
            withFrameNanos { now ->
                val seconds = (now - last) / 1e9f
                last = now
                sinceSample += seconds
                if (sinceSample >= SampleSeconds) {
                    sinceSample = 0f
                    history.copyInto(history, destinationOffset = 1, startIndex = 0, endIndex = history.size - 1)
                    history[0] = sqrt(level.coerceIn(0f, 1f))
                }
                val ease = 1f - exp(-seconds / EaseSeconds)
                for (i in history.indices) shown[i] += (history[i] * Envelope[i] - shown[i]) * ease
            }
        }
    }
    return shown
}
