package sh.ovis.app.fork.assistant.control

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Display
import android.view.Gravity
import android.view.WindowManager
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.ComposeView
import sh.ovis.app.fork.assistant.overlay.CallStatus
import sh.ovis.app.fork.assistant.overlay.EdgeGlow
import sh.ovis.app.fork.assistant.overlay.OverlayPhase
import sh.ovis.app.fork.assistant.overlay.OverlayProgress
import sh.ovis.app.fork.assistant.overlay.OverlayState
import sh.ovis.app.fork.assistant.session.ViewTreeOwners

data class Point(val x: Float, val y: Float)

/** A tap at [start], or a swipe from [start] to [end]. */
data class Touch(val start: Point, val end: Point? = null)

/**
 * The edge glow, with no pill, over every app while an agent controls the phone, and a ripple where it taps. The window
 * can't be touched, so every touch goes to the app underneath. It fades in on the first [signal] and stays through the
 * agent's thinking between commands. It fades out on [done], when the agent's turn ends, or [IDLE_MILLIS] after the
 * last signal when nothing says the turn ended. It needs the "Draw over other apps" permission; without it nothing shows.
 */
class ControlGlow private constructor(app: Context) {
    private val context: Context = app
        .createDisplayContext(app.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY))
        .createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
    private val windows = context.getSystemService(WindowManager::class.java)
    private val handler = Handler(Looper.getMainLooper())

    private var shown: Pair<ComposeView, ViewTreeOwners>? = null
    private var active by mutableStateOf(false)
    private val touches = mutableStateListOf<Pair<Long, Touch>>()
    private var nextId = 0L

    private val fade = Runnable {
        active = false
        handler.postDelayed(remove, FADE_MILLIS)
    }

    private val remove = Runnable {
        shown?.let { (view, owners) ->
            try {
                windows.removeViewImmediate(view)
            } catch (_: IllegalArgumentException) {
                // Already gone.
            }
            owners.destroy()
        }
        shown = null
        touches.clear()
    }

    fun signal(touch: Touch?) = handler.post {
        if (shown == null && !add()) return@post
        handler.removeCallbacks(remove)
        handler.removeCallbacks(fade)
        active = true
        touch?.let { touches += nextId++ to it }
        handler.postDelayed(fade, IDLE_MILLIS)
    }

    fun done() = handler.post {
        if (shown == null || !active) return@post
        handler.removeCallbacks(fade)
        fade.run()
    }

    private fun add(): Boolean {
        if (!Settings.canDrawOverlays(context)) return false
        val owners = ViewTreeOwners()
        val view = ComposeView(context).apply {
            setContent { ControlLayer(active, touches.toList()) { id -> touches.removeAll { it.first == id } } }
        }
        owners.attachTo(view)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // Android lets touches through an app's overlay only at 80% opacity or less, and would lower it itself.
            alpha = 0.8f
            // The window covers the whole display, so adb's screen pixels are its own.
            setFitInsetsTypes(0)
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }
        return try {
            windows.addView(view, params)
            shown = view to owners
            true
        } catch (_: RuntimeException) {
            // The permission was taken away since it was checked.
            owners.destroy()
            false
        }
    }

    companion object {
        /** How long after the agent's last command the glow fades out when no [done] comes. */
        const val IDLE_MILLIS = 30_000L
        private const val FADE_MILLIS = 400L

        @SuppressLint("StaticFieldLeak") // The application context.
        @Volatile
        private var instance: ControlGlow? = null

        fun get(context: Context): ControlGlow =
            instance ?: synchronized(this) { instance ?: ControlGlow(context.applicationContext).also { instance = it } }
    }
}

@Composable
private fun ControlLayer(active: Boolean, touches: List<Pair<Long, Touch>>, onRippleDone: (Long) -> Unit) {
    val progress = remember { OverlayProgress(open = false) }
    LaunchedEffect(active) { progress.play(opening = active) }
    Box(Modifier.fillMaxSize()) {
        EdgeGlow(OverlayState(phase = OverlayPhase.Open, call = CallStatus.Working), progress)
        touches.forEach { (id, touch) ->
            key(id) { Ripple(touch) { onRippleDone(id) } }
        }
    }
}

/** A ring that spreads and fades where the agent touched; a swipe rings at both ends. */
@Composable
private fun Ripple(touch: Touch, onDone: () -> Unit) {
    val t = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        t.animateTo(1f, tween(RIPPLE_MILLIS))
        onDone()
    }
    Canvas(Modifier.fillMaxSize()) {
        val radius = (12f + 36f * t.value) * density
        val color = RippleColor.copy(alpha = RippleColor.alpha * (1f - t.value))
        listOfNotNull(touch.start, touch.end).forEach { p ->
            val center = Offset(p.x, p.y)
            drawCircle(color.copy(alpha = color.alpha * 0.35f), radius, center)
            drawCircle(color, radius, center, style = Stroke(width = 3f * density))
        }
    }
}

private const val RIPPLE_MILLIS = 600
private val RippleColor = Color(0xE6B9C6FF)
