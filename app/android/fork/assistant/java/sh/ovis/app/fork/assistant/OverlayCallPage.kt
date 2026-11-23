package sh.ovis.app.fork.assistant

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import sh.ovis.app.AssistantAndroid
import sh.ovis.app.R
import java.util.function.Consumer

/** Loads just the call entry point of the saved PC's Ovis page, using the app's WebView cookie and pairing stores. */
internal class OverlayCallPage(private val context: Context, private val target: JSONObject) : AssistantCalls.Page {
    private val main = Handler(Looper.getMainLooper())
    private val oldPage = Runnable { fail(R.string.ovis_assistant_unreachable) }
    private val notificationAction = Consumer<String> { action -> command(action) }
    private var view: WebView? = null
    private var reply: JavaScriptReplyProxy? = null
    private var callStarted = false
    private var mutedBeforeReady = false

    fun start() {
        if (!AssistantCalls.claim(this)) return
        val pc = target.optString("pc")
        val origin = AssistantAndroid.origin(pc)
        val url = pc.trimEnd('/') + "/"
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail(R.string.ovis_assistant_microphone)
            return
        }
        if (origin == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !AssistantAndroid.listen(context, pc)) {
            fail(R.string.ovis_assistant_unreachable)
            return
        }
        // Take foreground microphone ownership while the voice session is showing, not after the PC answers.
        try {
            AssistantAndroid.notify(context, target.optString("label"), notificationAction)
            callStarted = true
        } catch (_: RuntimeException) {
            fail(R.string.ovis_assistant_microphone)
            return
        }
        val page = WebView(context.applicationContext)
        view = page
        @Suppress("SetJavaScriptEnabled")
        page.settings.javaScriptEnabled = true
        page.settings.domStorageEnabled = true
        page.settings.mediaPlaybackRequiresUserGesture = false
        page.settings.allowFileAccess = false
        page.settings.allowContentAccess = false
        page.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                AssistantAndroid.blockedSshRequest(request)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.isForMainFrame && request.url.toString() != url

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) fail(R.string.ovis_assistant_unreachable)
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, error: WebResourceResponse) {
                if (request.isForMainFrame) fail(R.string.ovis_assistant_unreachable)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                fail(R.string.ovis_assistant_unreachable)
                return true
            }
        }
        page.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (reply != null && view?.url == url && AssistantAndroid.origin(request.origin.toString()) == origin &&
                    context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED &&
                    request.resources.contentEquals(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else request.deny()
            }
        }
        WebViewCompat.addWebMessageListener(page, "OvisAssistantHost", setOf(origin)) { source, message, _, mainFrame, proxy ->
            if (mainFrame && source === view && source.url == url && AssistantCalls.owns(this)) {
                val data = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: org.json.JSONException) { return@addWebMessageListener }
                when (data.optString("event")) {
                    "ready" -> if (reply == null) {
                        reply = proxy
                        send(JSONObject().put("action", "start").put("target", target).put("muted", mutedBeforeReady))
                        AssistantCalls.ready(this)
                    }
                    "state" -> {
                        val snapshot = data.optJSONObject("snapshot") ?: return@addWebMessageListener
                        if (snapshot.optString("status") != "starting") main.removeCallbacks(oldPage)
                        AssistantCalls.publish(this, snapshot)
                    }
                    "notice" -> AssistantAndroid.updateNotice(context, data)
                    "muted" -> if (callStarted) AssistantAndroid.muted(data.optBoolean("muted"))
                    "release" -> close()
                }
            }
        }
        main.postDelayed(oldPage, 30_000)
        page.loadUrl(url)
    }

    override fun command(action: String) {
        if (reply != null) {
            send(JSONObject().put("action", action))
        } else when (action) {
            "hangup" -> close()
            "mute" -> {
                mutedBeforeReady = !mutedBeforeReady
                AssistantAndroid.muted(mutedBeforeReady)
            }
        }
    }

    private fun send(message: JSONObject) { reply?.postMessage(message.toString()) }

    private fun fail(message: Int) {
        if (AssistantCalls.owns(this)) {
            AssistantCalls.publish(this, JSONObject().put("status", "ended").put("notice", context.getString(message)))
        }
        close()
    }

    private fun close() {
        if (callStarted) AssistantAndroid.stop(context, notificationAction)
        callStarted = false
        AssistantCalls.release(this)
        main.removeCallbacks(oldPage)
        reply = null
        val page = view ?: return
        view = null
        // Chromium callbacks can still be on the stack when it asks to close.
        main.post { page.destroy() }
    }
}
