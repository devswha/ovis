package sh.ovis.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.webkit.WebView
import androidx.annotation.RequiresApi
import android.provider.Settings
import android.service.voice.VoiceInteractionService
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject
import sh.ovis.app.fork.assistant.AssistantCalls
import sh.ovis.app.fork.assistant.session.AssistantService

/** Join Ovis's saved PC, microphone permission and call notification; store no second credential. */
internal object AssistantAndroid {
    private fun prefs(context: Context) = context.getSharedPreferences("side-button-assistant", Context.MODE_PRIVATE)

    fun target(context: Context): JSONObject? = try {
        prefs(context).getString("target", null)?.let(::JSONObject)?.takeIf { PCStore.saved(context).contains(it.optString("pc")) }
    } catch (_: org.json.JSONException) { null }

    fun save(context: Context, target: JSONObject?) = prefs(context).edit().putString("target", target?.toString()).apply()

    fun origin(pc: String): String? = PCStore.origin(pc)
    fun listen(context: Context, pc: String) = OvisSshPlugin.listen(context, pc)

    fun notify(context: Context, label: String, action: java.util.function.Consumer<String>) {
        LiveCallService.start(context, "Ovis", label, "Mute", "Unmute", true)
        LiveCallService.onAction = action
    }

    fun updateNotice(context: Context, words: JSONObject) = LiveCallService.updateText(context,
        words.optString("title", "Ovis"), words.optString("mute", "Mute"), words.optString("unmute", "Unmute"))

    fun muted(muted: Boolean) = LiveCallService.setMuted(muted)

    fun overlayVisible(visible: Boolean) = LiveCallService.setOverlayVisible(visible)

    fun blockedSshRequest(request: android.webkit.WebResourceRequest) = SshWebRequests.blocked(request)

    fun stop(context: Context, action: java.util.function.Consumer<String>) {
        if (LiveCallService.onAction === action) LiveCallService.onAction = null
        LiveCallService.stop(context)
    }
}

@RequiresApi(33)
@CapacitorPlugin(name = "OvisAssistant", permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])])
class AssistantPlugin : Plugin() {
    private val page = object : AssistantCalls.Page {
        override fun command(action: String) { notifyListeners("assistantCall", JSObject().put("action", action)) }
    }

    private val navigation = object : WebViewListener() {
        override fun onPageStarted(webView: WebView) { AssistantCalls.release(page) }
    }

    override fun load() { bridge.addWebViewListener(navigation) }

    /** The approved PC visible in this window, not an address provided by the page. */
    private fun pc(): String? {
        val url = bridge.webView.url ?: return null
        val pc = PCStore.appScope(url) ?: (activity as? MainActivity)?.origin() ?: return null
        if (PCStore.showsHostedShell(pc) && !PCStore.scoped(pc)) return null
        return pc.takeIf { PCStore.saved(context).contains(it) && PCStore.belongs(url, it) && PCStore.appPage(url, it) }
    }

    @PluginMethod
    fun state(call: PluginCall) = activity.runOnUiThread {
        val pc = pc()
        val target = AssistantAndroid.target(context)
        val result = JSObject().put("available", pc != null).put("enabled", target != null)
        result.put("role", VoiceInteractionService.isActiveService(context, ComponentName(context, AssistantService::class.java)))
        if (target != null) {
            result.put("label", target.optString("label"))
            if (pc == target.optString("pc")) {
                result.put("machineId", target.optString("machineId"))
                result.put("paneId", target.optString("paneId"))
            }
        }
        call.resolve(result)
    }

    @PluginMethod
    fun choose(call: PluginCall) = activity.runOnUiThread {
        if (pc() == null) { call.reject("Not a saved PC."); return@runOnUiThread }
        if (call.getString("paneId").isNullOrEmpty() || getPermissionState("microphone") == PermissionState.GRANTED) {
            saveChoice(call)
        } else requestPermissionForAlias("microphone", call, "microphoneAnswered")
    }

    @PermissionCallback
    private fun microphoneAnswered(call: PluginCall) {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) saveChoice(call)
        else call.reject("Microphone permission is required.", "microphone")
    }

    private fun saveChoice(call: PluginCall) {
        val pc = pc() ?: run { call.reject("Not a saved PC."); return }
        val pane = call.getString("paneId")
        val target = if (pane.isNullOrEmpty()) null else JSONObject()
            .put("pc", pc).put("paneId", pane).put("machineId", call.getString("machineId", "local"))
            .put("label", call.getString("label", "Pi")).put("voice", call.getString("voice"))
        AssistantAndroid.save(context, target)
        call.resolve()
    }

    @PluginMethod
    fun openSettings(call: PluginCall) = activity.runOnUiThread {
        try {
            activity.startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            try {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
            } catch (_: ActivityNotFoundException) {
                call.reject("Android assistant settings are unavailable.")
                return@runOnUiThread
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun claimCall(call: PluginCall) = activity.runOnUiThread {
        call.resolve(JSObject().put("claimed", AssistantCalls.claim(page)))
    }

    @PluginMethod
    fun callReady(call: PluginCall) = activity.runOnUiThread { AssistantCalls.ready(page); call.resolve() }

    @PluginMethod
    fun callState(call: PluginCall) = activity.runOnUiThread { AssistantCalls.publish(page, call.data); call.resolve() }

    @PluginMethod
    fun releaseCall(call: PluginCall) = activity.runOnUiThread { AssistantCalls.release(page); call.resolve() }

    override fun handleOnDestroy() {
        bridge.removeWebViewListener(navigation)
        if (AssistantCalls.owns(page)) {
            LiveCallService.stop(activity)
            AssistantCalls.release(page)
        }
        super.handleOnDestroy()
    }
}
