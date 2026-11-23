package sh.ovis.app.fork.assistant.overlay

import android.view.RoundedCorner
import android.view.View
import android.view.WindowInsets
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView

/** The display's four corner radii in px; folded, the outer screen's corners differ from each other. */
internal data class CornerRadii(val topLeft: Float, val topRight: Float, val bottomRight: Float, val bottomLeft: Float) {
    constructor(all: Float) : this(all, all, all, all)
}

/** Used until the window reports its display's corners, and on displays that report none. */
private val FallbackCorners = CornerRadii(142f)

private fun WindowInsets.cornerRadius(position: Int) = getRoundedCorner(position)?.radius?.toFloat() ?: 0f

/** The corner radii the window reports, or null when it reports none. */
private fun WindowInsets.screenCorners(): CornerRadii? {
    val corners = CornerRadii(
        cornerRadius(RoundedCorner.POSITION_TOP_LEFT),
        cornerRadius(RoundedCorner.POSITION_TOP_RIGHT),
        cornerRadius(RoundedCorner.POSITION_BOTTOM_RIGHT),
        cornerRadius(RoundedCorner.POSITION_BOTTOM_LEFT),
    )
    return corners.takeIf { it != CornerRadii(0f) }
}

/** The display's corner radii, read from the window and re-read when the window changes size (folding). */
@Composable
internal fun rememberScreenCorners(): CornerRadii {
    val view = LocalView.current
    var corners by remember { mutableStateOf(FallbackCorners) }
    DisposableEffect(view) {
        fun read() {
            val insets = view.rootWindowInsets ?: return
            corners = insets.screenCorners() ?: FallbackCorners
        }
        val onLayout = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> read() }
        read()
        view.addOnLayoutChangeListener(onLayout)
        onDispose { view.removeOnLayoutChangeListener(onLayout) }
    }
    return corners
}
