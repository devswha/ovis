package sh.ovis.app.fork.assistant.overlay

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

private val DismissDistance = 72.dp
private val DismissVelocity = 1200.dp

/** Pulling the content down moves it with the finger; letting go past [DismissDistance], or flicking, dismisses. */
@Composable
internal fun Modifier.swipeDownToDismiss(onDismiss: () -> Unit): Modifier {
    var offset by remember { mutableFloatStateOf(0f) }
    val draggable = rememberDraggableState { delta -> offset = (offset + delta).coerceAtLeast(0f) }
    val density = LocalDensity.current
    return this
        .graphicsLayer { translationY = offset }
        .draggable(
            state = draggable,
            orientation = Orientation.Vertical,
            onDragStopped = { velocity ->
                if (offset > with(density) { DismissDistance.toPx() } || velocity > with(density) { DismissVelocity.toPx() }) {
                    onDismiss()
                } else {
                    animate(offset, 0f, animationSpec = spring()) { value, _ -> offset = value }
                }
            },
        )
}
