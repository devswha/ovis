package sh.ovis.app.fork.assistant.overlay

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.util.lerp
import sh.ovis.app.R
import kotlin.math.PI
import kotlin.math.cos

/**
 * The pill: the waveform. It has no buttons: a tap outside closes the overlay and the call goes on in its notification. The waveform is there from the first frame, so nothing moves when the call
 * connects: its dots breathe while connecting, ripple while the assistant works and follow whoever is talking
 * otherwise. A failure shows its notice instead. A parked call, whose task still runs with the connection to OpenAI
 * closed, says so in place of the waveform, and tapping those words brings the voice back.
 */
@Composable
internal fun InputPill(
    state: OverlayState,
    progress: OverlayProgress,
    onAction: (OverlayAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .height(OverlayDimens.PillHeight)
            .entrance(state.phase == OverlayPhase.Closing) { progress[Track.Pill] }
            .softCapsule()
            .padding(start = OverlayDimens.PillTextStart, end = OverlayDimens.PillTextStart)
            .pointerInput(Unit) { detectTapGestures { } },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.CenterStart) {
            val face = state.call.takeIf { it == CallStatus.Failed || it == CallStatus.Parked }
            Crossfade(face, label = "pillFace") { shown ->
                when (shown) {
                    CallStatus.Failed -> Status(state.notice.orEmpty())
                    CallStatus.Parked -> ParkedNote(onResume = { onAction(OverlayAction.ResumeTapped) })
                    else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        DottedWaveform(waveformLevel(state))
                    }
                }
            }
        }
    }
}

/**
 * What the waveform shows: a slow breath while connecting, a quicker, stronger one while the assistant works (the
 * waveform carries each level outward, so either reads as a ripple), whoever is talking otherwise, and flat while the
 * microphone is off.
 */
@Composable
private fun waveformLevel(state: OverlayState): Float {
    val beat by rememberInfiniteTransition(label = "waveformBeat").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(BeatMillis, easing = LinearEasing)),
        label = "beat",
    )
    fun breath(cycles: Int, depth: Float) = depth * (0.5f - 0.5f * cos(2f * PI.toFloat() * cycles * beat))
    return when {
        state.call == CallStatus.Connecting -> breath(cycles = 1, depth = 0.25f)
        state.call == CallStatus.Working -> breath(cycles = 3, depth = 0.45f)
        state.muted -> 0f
        state.call == CallStatus.Speaking -> state.speakerLevel
        else -> state.micLevel
    }
}

/** One slow breath while connecting; working fits three into the same time. */
private const val BeatMillis = 1800

@Composable
private fun Status(text: String) {
    Text(text, style = OverlayType.Hint, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(end = OverlayDimens.ButtonGap))
}

/** What a parked call says: the task is still running, and the voice comes back with its result or on a tap. */
@Composable
private fun ParkedNote(onResume: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = ripple(color = OverlayColors.Content),
                role = Role.Button,
                onClickLabel = stringResource(R.string.overlay_resume),
                onClick = onResume,
            ),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(stringResource(R.string.overlay_parked), style = OverlayType.Note, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(stringResource(R.string.overlay_parked_hint), style = OverlayType.Caption, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * In, the pill grows from its centre, blurred and see-through, and is sharp before it has finished growing. Out, it
 * sinks and fades.
 */
private fun Modifier.entrance(closing: Boolean, progress: () -> Float) = graphicsLayer {
    val p = progress()
    alpha = (p / OverlayMotion.PillOpaqueAt).coerceIn(0f, 1f)
    if (closing) {
        val scale = lerp(OverlayMotion.DropScale, 1f, p)
        scaleX = scale
        scaleY = scale
        translationY = (1f - p) * OverlayMotion.Drop.toPx()
    } else {
        val scale = lerp(OverlayMotion.PillScaleFrom, 1f, p)
        scaleX = scale
        scaleY = scale
        val blur = OverlayMotion.PillBlurFrom.toPx() * (1f - p / OverlayMotion.PillSharpAt).coerceIn(0f, 1f)
        renderEffect = if (blur > 0.5f) BlurEffect(blur, blur, TileMode.Decal) else null
    }
}
