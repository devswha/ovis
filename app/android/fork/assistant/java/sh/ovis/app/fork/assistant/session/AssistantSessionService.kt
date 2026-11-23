package sh.ovis.app.fork.assistant.session

import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService

class AssistantSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession =
        if (android.os.Build.VERSION.SDK_INT >= 33) AssistantSession(this) else VoiceInteractionSession(this)
}
