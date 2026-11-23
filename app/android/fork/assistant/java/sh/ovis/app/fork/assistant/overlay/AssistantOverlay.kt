package sh.ovis.app.fork.assistant.overlay

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.tappableElement
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput

/**
 * The side-button overlay for a call: edge glow, bottom shadow and the pill over the current app. Fills its
 * window, plays the opening and closing as [OverlayState.phase] asks and reports [OverlayAction.Opened] and
 * [OverlayAction.Closed] when they end. A tap outside or a swipe down reports [OverlayAction.Shrink].
 */
@Composable
fun AssistantOverlay(
    state: OverlayState,
    onAction: (OverlayAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val progress = remember { OverlayProgress(open = state.phase != OverlayPhase.Opening) }
    val currentOnAction by rememberUpdatedState(onAction)

    LaunchedEffect(state.phase) {
        when (state.phase) {
            OverlayPhase.Opening -> {
                progress.play(opening = true)
                currentOnAction(OverlayAction.Opened)
            }
            OverlayPhase.Open -> progress.snapTo(open = true)
            OverlayPhase.Closing -> {
                progress.play(opening = false)
                currentOnAction(OverlayAction.Closed)
            }
        }
    }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .pointerInput(Unit) { detectTapGestures { currentOnAction(OverlayAction.Shrink) } },
    ) {
        val column = Modifier.align(OverlayDimens.ColumnAnchor).width(minOf(maxWidth, OverlayDimens.ColumnMaxWidth))
        BottomShadow(progress, column.fillMaxHeight())
        EdgeGlow(state, progress)
        Controls(state, progress, onAction, column)
    }
}

/** The pill, centred in the column. */
@Composable
private fun Controls(
    state: OverlayState,
    progress: OverlayProgress,
    onAction: (OverlayAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .windowInsetsPadding(WindowInsets.tappableElement)
            .padding(bottom = OverlayDimens.BottomMargin)
            .swipeDownToDismiss { onAction(OverlayAction.Shrink) },
    ) {
        InputPill(
            state,
            progress,
            onAction,
            Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = OverlayDimens.MinSideMargin)
                .widthIn(max = OverlayDimens.PillMaxWidth)
                .fillMaxWidth(),
        )
    }
}
