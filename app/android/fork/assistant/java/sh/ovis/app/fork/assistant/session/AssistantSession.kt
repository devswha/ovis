package sh.ovis.app.fork.assistant.session

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.view.View
import android.view.WindowManager
import androidx.annotation.RequiresApi
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.ComposeView
import androidx.core.view.WindowCompat
import sh.ovis.app.AssistantAndroid
import sh.ovis.app.fork.assistant.AssistantCalls
import sh.ovis.app.fork.assistant.OverlayCallPage
import sh.ovis.app.fork.assistant.overlay.AssistantOverlay
import sh.ovis.app.fork.assistant.overlay.OverlayAction
import sh.ovis.app.fork.assistant.overlay.OverlayPhase
import sh.ovis.app.fork.assistant.overlay.OverlayState
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One press of the side button: a transparent, edge-to-edge window over the current app that shows [AssistantOverlay]
 * for a call with the assistant. Closing the session leaves the call with its WebView and notification.
 *
 * - A press with no call going starts one. With a call going (the overlay was closed) it shows that call again.
 * - A press while the overlay is up ends the call, or starts a new one if the call had failed.
 * - Tapping outside, swiping down and leaving the app close the overlay and keep the call, in its notification. Back and End
 *   end the call.
 *
 * It never starts an activity (HyperOS blocks that from the background) and asks for neither assist data nor a
 * screenshot, so the overlay opens as fast as possible.
 */
@RequiresApi(33)
class AssistantSession(context: Context) : VoiceInteractionSession(context) {
    private val scope = MainScope()
    private val owners = ViewTreeOwners()
    private val state = MutableStateFlow(OverlayState())
    private var watching: Job? = null
    private var showing = false

    override fun onCreate() {
        setDisabledShowContext(SHOW_WITH_ASSIST or SHOW_WITH_SCREENSHOT)
    }

    override fun onCreateContentView(): View {
        requireNotNull(window.window).apply {
            setFormat(PixelFormat.TRANSLUCENT)
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            WindowCompat.setDecorFitsSystemWindows(this, false)
            // Draw behind the system bars ourselves, or HyperOS paints an opaque black status bar over the overlay.
            addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            @Suppress("DEPRECATION")
            statusBarColor = Color.TRANSPARENT
            @Suppress("DEPRECATION")
            navigationBarColor = Color.TRANSPARENT
            isStatusBarContrastEnforced = false
            isNavigationBarContrastEnforced = false
            attributes = attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
            owners.attachTo(decorView)
        }
        return ComposeView(context).apply {
            setContent {
                val overlayState by state.collectAsState()
                AssistantOverlay(overlayState, ::onAction)
            }
        }
    }

    override fun onPrepareShow(args: Bundle?, showFlags: Int) {
        setUiEnabled(AssistantAndroid.target(context) != null)
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        val target = AssistantAndroid.target(context) ?: run { finish(); return }
        if (showing) {
            if (state.value.notice != null) OverlayCallPage(context, target).start() else onBackPressed()
            return
        }
        showing = true
        AssistantAndroid.overlayVisible(true)
        state.value = OverlayState()
        if (!AssistantCalls.active()) OverlayCallPage(context, target).start()
        AssistantCalls.watch(true)
        watching = scope.launch {
            AssistantCalls.state.collect { call ->
                if (call == null || call.optString("status") == "idle") close()
                else state.update { it.showing(call) }
            }
        }
    }

    /** Home, lock or another app have already hidden the window; keep the call in its notification. */
    override fun onHide() {
        AssistantAndroid.overlayVisible(false)
        if (showing) {
            stopWatching()
            finish()
        }
    }

    override fun onBackPressed() {
        AssistantCalls.command("hangup")
        close()
    }

    override fun onDestroy() {
        AssistantAndroid.overlayVisible(false)
        if (showing) stopWatching()
        scope.cancel()
        owners.destroy()
    }

    private fun close() {
        if (!showing) return
        stopWatching()
        state.update { it.copy(phase = OverlayPhase.Closing) }
    }

    private fun stopWatching() {
        showing = false
        watching?.cancel()
        AssistantCalls.watch(false)
    }

    private fun onAction(action: OverlayAction) {
        when (action) {
            OverlayAction.Opened -> state.update {
                if (it.phase == OverlayPhase.Opening) it.copy(phase = OverlayPhase.Open) else it
            }
            OverlayAction.Closed -> finish()
            OverlayAction.Shrink -> close()
            OverlayAction.ResumeTapped -> AssistantCalls.command("resume")
        }
    }
}
