package sh.ovis.app.fork.assistant

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/** The app's WebView and the session's WebView use the same call engine, one owner at a time. Main thread only. */
internal object AssistantCalls {
    interface Page {
        fun command(action: String)
    }

    private var owner: Page? = null
    private var watching = false
    private val mutableState = MutableStateFlow<JSONObject?>(null)
    val state = mutableState.asStateFlow()

    fun active() = owner != null && state.value?.optString("status") in setOf("starting", "live")

    fun claim(page: Page): Boolean {
        if (owner != null) return false
        owner = page
        mutableState.value = JSONObject().put("status", "starting")
        return true
    }

    fun owns(page: Page) = owner === page

    fun publish(page: Page, snapshot: JSONObject) {
        if (owns(page)) mutableState.value = snapshot
    }

    fun release(page: Page) {
        if (!owns(page)) return
        owner = null
        if (state.value?.optString("status") != "ended") mutableState.value = null
    }

    fun watch(show: Boolean) {
        watching = show
        command(if (show) "watch" else "unwatch")
    }

    fun ready(page: Page) {
        if (owns(page) && watching) page.command("watch")
    }

    fun command(action: String) = owner?.command(action)
}
