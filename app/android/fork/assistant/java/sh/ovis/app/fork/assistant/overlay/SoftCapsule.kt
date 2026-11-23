package sh.ovis.app.fork.assistant.overlay

import android.graphics.BlurMaskFilter
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.unit.dp

private val HaloLift = 2.dp

private fun blurred(color: Color, radius: Float) = Paint().apply {
    this.color = color
    asFrameworkPaint().maskFilter = BlurMaskFilter(radius, BlurMaskFilter.Blur.NORMAL)
}

/** The dark, softly edged capsule behind the pill, with a faint halo that lifts it off the app. */
internal fun Modifier.softCapsule(): Modifier = drawWithCache {
    val halo = blurred(Color.Black.copy(alpha = 0.55f), OverlayDimens.Halo.toPx())
    val fill = blurred(OverlayColors.Surface, OverlayDimens.SoftEdge.toPx())
    val radius = size.height / 2f
    val lift = HaloLift.toPx()
    onDrawBehind {
        drawIntoCanvas { canvas ->
            canvas.drawRoundRect(0f, lift, size.width, size.height + lift, radius, radius, halo)
            canvas.drawRoundRect(0f, 0f, size.width, size.height, radius, radius, fill)
        }
    }
}
