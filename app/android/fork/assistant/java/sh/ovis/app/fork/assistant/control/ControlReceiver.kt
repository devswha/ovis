package sh.ovis.app.fork.assistant.control

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import sh.ovis.app.AssistantAndroid

/**
 * An agent is controlling the phone over adb: `fold-adb` sends this before each command that drives it. Only the shell
 * can send it (the manifest asks for DUMP, which adb's shell holds). A tap or swipe comes with its screen pixels as
 * `x`, `y` and, for a swipe, `x2`, `y2`. The assistant's pi sends `done` when its turn ends, which fades the glow now.
 */
class ControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Build.VERSION.SDK_INT < 33) return
        if (intent.getBooleanExtra("done", false)) {
            ControlGlow.get(context).done()
            return
        }
        if (AssistantAndroid.target(context) == null) return
        val touch = intent.point("x", "y")?.let { start -> Touch(start, intent.point("x2", "y2")) }
        ControlGlow.get(context).signal(touch)
    }

    private fun Intent.point(x: String, y: String): Point? =
        if (hasExtra(x) && hasExtra(y)) Point(getIntExtra(x, 0).toFloat(), getIntExtra(y, 0).toFloat()) else null
}
