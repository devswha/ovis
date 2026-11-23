package sh.ovis.app.fork.assistant.overlay

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

private val ReachX = 382.dp
private val ReachY = 233.dp

/** Black at the middle of the shadow and clear at its edge, as measured from the reference. */
private val Fade = arrayOf(
    0f to Color.Black.copy(alpha = 0.92f),
    0.2f to Color.Black.copy(alpha = 0.85f),
    0.45f to Color.Black.copy(alpha = 0.66f),
    0.7f to Color.Black.copy(alpha = 0.30f),
    1f to Color.Black.copy(alpha = 0f),
)

/** Darkens the bottom of the screen around the pill so the pill reads over any app. Centred on [modifier]. */
@Composable
internal fun BottomShadow(progress: OverlayProgress, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    val reachX = with(density) { ReachX.toPx() }
    val reachY = with(density) { ReachY.toPx() }
    val brush = remember(reachX) { Brush.radialGradient(*Fade, center = Offset.Zero, radius = reachX) }

    Canvas(modifier) {
        val alpha = progress[Track.Shadow]
        if (alpha == 0f) return@Canvas
        val centerX = size.width / 2
        // A circle of radius reachX squashed to an ellipse sitting on the bottom edge.
        withTransform({
            translate(centerX, size.height)
            scale(1f, reachY / reachX, pivot = Offset.Zero)
        }) {
            drawRect(brush, topLeft = Offset(-reachX, -reachX), size = Size(2 * reachX, reachX), alpha = alpha)
        }
    }
}
