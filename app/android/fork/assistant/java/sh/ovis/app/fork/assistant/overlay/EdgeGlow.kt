package sh.ovis.app.fork.assistant.overlay

import android.graphics.RuntimeShader
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.FloatState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ShaderBrush
import kotlin.math.sin

/**
 * The light along the window edge: it sweeps in from [OverlayState.glowOrigin], then its colours drift and it breathes
 * with whoever is talking: the mic while listening, the assistant's voice while it speaks, and a slow pulse while it
 * works. It rests while connecting, while the mic is muted and after a failure.
 */
@Composable
internal fun EdgeGlow(state: OverlayState, progress: OverlayProgress, modifier: Modifier = Modifier) {
    val corners = rememberScreenCorners()
    val level by animateFloatAsState(
        targetValue = state.glowTarget(),
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label = "glowLevel",
    )
    val time = rememberSeconds()
    val shader = remember { RuntimeShader(EdgeGlowShader) }
    val brush = remember(shader) { ShaderBrush(shader) }

    Canvas(modifier.fillMaxSize()) {
        val sweep = progress[Track.Glow]
        val bloom = progress[Track.Bloom]
        if (sweep == 0f && bloom == 0f) return@Canvas
        shader.setFloatUniform("size", size.width, size.height)
        shader.setFloatUniform("dp", density)
        shader.setFloatUniform("radii", corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft)
        shader.setFloatUniform("time", time.floatValue)
        shader.setFloatUniform("origin", state.glowOrigin.x * size.width, state.glowOrigin.y * size.height)
        shader.setFloatUniform("sweep", sweep)
        shader.setFloatUniform("bloom", bloom)
        val pulse = if (state.call == CallStatus.Working && !state.muted) WorkingPulse * sin(time.floatValue * WorkingRate) else 0f
        shader.setFloatUniform("level", (level + pulse).coerceIn(0f, 1f))
        drawRect(brush)
    }
}

private const val WorkingLevel = 0.3f
private const val WorkingPulse = 0.12f

/** Radians a second: one breath about every 2.4 s. */
private const val WorkingRate = 2.6f

private fun OverlayState.glowTarget(): Float = when {
    muted -> 0f
    call == CallStatus.Listening -> micLevel
    call == CallStatus.Speaking -> speakerLevel
    call == CallStatus.Working -> WorkingLevel
    else -> 0f
}.coerceIn(0f, 1f)

/** Seconds since this was first composed, advanced every frame and only read while drawing. */
@Composable
private fun rememberSeconds(): FloatState {
    val seconds = remember { mutableFloatStateOf(0f) }
    LaunchedEffect(Unit) {
        val start = withFrameNanos { it }
        while (true) withFrameNanos { seconds.floatValue = (it - start) / 1e9f }
    }
    return seconds
}
