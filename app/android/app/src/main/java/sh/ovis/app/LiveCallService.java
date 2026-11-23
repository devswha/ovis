package sh.ovis.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.annotation.RequiresApi;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.graphics.drawable.IconCompat;
import java.util.function.Consumer;

/**
 * Keeps a live call (src/lib/piVoiceSession.ts) going once the app is out of sight or the screen
 * is locked: Android lets only a foreground service of the microphone type go on recording, and
 * keeps its process and network up meanwhile. The page starts it once the call has the
 * microphone and stops it when the call lets go of it.
 *
 * It also plays the call on the loudspeaker when no headset is connected: Android sends a call's
 * sound to the earpiece, which is held to the ear. A headset, wired or Bluetooth, keeps the call,
 * its microphone included. Android before 12 keeps its own choice.
 */
public class LiveCallService extends Service {
    private static final String CHANNEL = "live-call-ongoing";
    private static final int ID = 1;
    private static final String HANG_UP = "sh.ovis.app.LIVE_CALL_HANG_UP";
    private static final String TOGGLE_MUTE = "sh.ovis.app.LIVE_CALL_TOGGLE_MUTE";

    /** What the notification's buttons ask of the page's call, "hangup" or "mute" (HerdrShellPlugin). */
    static Consumer<String> onAction;
    // the service whose notification is up, which the page's mute updates
    private static LiveCallService shown;
    private static boolean overlayVisible;
    private String title = "Ovis";
    private String body = "";
    private String muteLabel = "Mute";
    private String unmuteLabel = "Unmute";
    private boolean muted;

    // the call that holds the loudspeaker, which one ending a moment ago must not take back
    private static LiveCallService current;
    private AudioManager audio;
    // Android's own phone call for this one, which routes its sound instead (TelecomCall)
    private TelecomCall call;
    // a headset plugged in or taken out mid-call
    private final AudioDeviceCallback devices = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            route();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            route();
        }
    };
    // the WebView starting its call's sound puts it back on the earpiece
    private AudioManager.OnCommunicationDeviceChangedListener changed;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT < 31) return;
        current = this;
        audio = getSystemService(AudioManager.class);
        changed = device -> {
            if (device != null && device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) route();
        };
        audio.addOnCommunicationDeviceChangedListener(getMainExecutor(), changed);
        audio.registerAudioDeviceCallback(devices, new Handler(Looper.getMainLooper()));
        route();
    }

    /** The loudspeaker, unless a headset is there to take the call. */
    private void route() {
        if (Build.VERSION.SDK_INT < 31 || call != null) return;
        AudioDeviceInfo speaker = null;
        for (AudioDeviceInfo device : audio.getAvailableCommunicationDevices()) {
            int type = device.getType();
            if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) speaker = device;
            else if (type != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                // wired, USB or Bluetooth: Android's own choice is the headset
                audio.clearCommunicationDevice();
                return;
            }
        }
        if (speaker != null) audio.setCommunicationDevice(speaker);
    }

    @Override
    public void onDestroy() {
        if (shown == this) shown = null;
        if (Build.VERSION.SDK_INT >= 31) {
            audio.unregisterAudioDeviceCallback(devices);
            // the WebView lets go of a call's sound a moment after the call ends: letting go of the
            // loudspeaker before it sends that moment, and the close chime in it, to the earpiece
            if (audio.getMode() == AudioManager.MODE_IN_COMMUNICATION) releaseAfterCall();
            else release();
        }
        super.onDestroy();
    }

    private void releaseAfterCall() {
        Handler main = new Handler(Looper.getMainLooper());
        AudioManager.OnModeChangedListener[] ended = new AudioManager.OnModeChangedListener[1];
        Runnable done = () -> {
            if (ended[0] == null) return;
            audio.removeOnModeChangedListener(ended[0]);
            ended[0] = null;
            release();
        };
        ended[0] = mode -> {
            if (mode == AudioManager.MODE_IN_COMMUNICATION) return;
            main.removeCallbacks(done);
            done.run();
        };
        audio.addOnModeChangedListener(getMainExecutor(), ended[0]);
        // a WebView that keeps the call's sound
        main.postDelayed(done, 5000);
    }

    private void release() {
        // ended only now, so the close chime is still a call's sound on the loudspeaker
        if (call != null) {
            call.end();
            call = null;
        }
        audio.removeOnCommunicationDeviceChangedListener(changed);
        // a call started since then has the loudspeaker now
        if (current == this) {
            current = null;
            audio.clearCommunicationDevice();
        }
    }

    /** The activity or voice session that owns the call. Closing a different window leaves it alone. */
    private static Context owner;

    /** Throws when the app is no longer in view, where Android starts no service. */
    static void start(Context context, String title, String body, String mute, String unmute) {
        start(context, title, body, mute, unmute, false);
    }

    static void start(Context context, String title, String body, String mute, String unmute, boolean foreground) {
        Intent intent = new Intent(context, LiveCallService.class).putExtra("title", title).putExtra("body", body)
            .putExtra("mute", mute).putExtra("unmute", unmute);
        if (foreground) context.startForegroundService(intent);
        else context.startService(intent);
        owner = context;
    }

    static void updateText(Context context, String title, String mute, String unmute) {
        if (owner != context || shown == null) return;
        shown.title = title;
        shown.muteLabel = mute;
        shown.unmuteLabel = unmute;
        shown.post();
    }

    static void setOverlayVisible(boolean visible) {
        if (overlayVisible == visible) return;
        overlayVisible = visible;
        if (shown != null) shown.post();
    }

    /** The page's call muted or unmuted: the notification's button turns to match. */
    static void setMuted(boolean muted) {
        LiveCallService service = shown;
        if (service == null || service.muted == muted) return;
        service.muted = muted;
        service.post();
    }

    /** Ends the call of `context`'s window; a call another window has goes on. */
    static void stop(Context context) {
        if (owner != null && owner != context) return;
        owner = null;
        context.stopService(new Intent(context, LiveCallService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (HANG_UP.equals(action) || TOGGLE_MUTE.equals(action)) {
            Consumer<String> page = onAction;
            if (page != null) page.accept(HANG_UP.equals(action) ? "hangup" : "mute");
            // no page left to end the call: the notification goes at least
            else if (HANG_UP.equals(action)) stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            title = or(intent.getStringExtra("title"), "Ovis");
            body = or(intent.getStringExtra("body"), "");
            muteLabel = or(intent.getStringExtra("mute"), "Mute");
            unmuteLabel = or(intent.getStringExtra("unmute"), "Unmute");
        }
        NotificationManager notifications = getSystemService(NotificationManager.class);
        // the first channel was silent, and so hidden from the lock screen; a channel keeps its importance
        notifications.deleteNotificationChannel("live-call");
        NotificationChannel channel = new NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_DEFAULT);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        notifications.createNotificationChannel(channel);
        shown = this;
        post();
        if (Build.VERSION.SDK_INT >= 34 && call == null) startCall();
        return START_NOT_STICKY;
    }

    @RequiresApi(34)
    private void startCall() {
        try {
            call = new TelecomCall(this, title, action -> {
                Consumer<String> page = onAction;
                if (page != null) page.accept(action);
            }, () -> {
                call = null;
                route();
            });
            // Telecom routes the call's sound from here
            audio.clearCommunicationDevice();
        } catch (RuntimeException refused) {
            call = null;
        }
    }

    /**
     * A phone call's notification, as ChatGPT's voice shows: on the lock screen with Hang up and
     * Mute, and in the status bar's call chip where the phone has one. Android takes a call's style
     * only from a foreground service, so a change posts it through startForeground again.
     */
    private void post() {
        // a tap goes back to the app as its launcher icon does
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (overlayVisible) AssistantCallNotification.createChannel(getSystemService(NotificationManager.class), title);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, overlayVisible ? AssistantCallNotification.CHANNEL : CHANNEL)
            .setSmallIcon(sh.ovis.push.R.drawable.ic_stat_ovis)
            .setContentText(body)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open == null ? null : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE));
        if (overlayVisible) AssistantCallNotification.quiet(builder, title);
        else {
            // The public card carries Hang up and a status-bar chip, without a banner.
            Person caller = new Person.Builder().setName(title).setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher)).setImportant(true).build();
            builder.setRequestPromotedOngoing(true).setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_CALL).setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, button(HANG_UP)));
        }
        Notification notification = builder.addAction(new NotificationCompat.Action.Builder(
                IconCompat.createWithResource(this, muted ? R.drawable.ic_call_mic : R.drawable.ic_call_mic_off),
                muted ? unmuteLabel : muteLabel, button(TOGGLE_MUTE)).build())
            .build();
        int microphone = Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        try {
            try {
                // a phone call's service, for the phone call it is to Android (TelecomCall)
                ServiceCompat.startForeground(this, ID, notification, Build.VERSION.SDK_INT >= 34 ? microphone | ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL : microphone);
            } catch (SecurityException noCall) {
                ServiceCompat.startForeground(this, ID, notification, microphone);
            }
        } catch (RuntimeException refused) {
            // no microphone permission, or no longer in view: the call goes on only while the app is
            stopSelf();
        }
    }

    private PendingIntent button(String action) {
        Intent intent = new Intent(this, LiveCallService.class).setAction(action);
        return PendingIntent.getService(this, HANG_UP.equals(action) ? 1 : 2, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static String or(String value, String fallback) {
        return value == null ? fallback : value;
    }

    /** Swiping Ovis away from Recents removes the activity's page, not the voice session's. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (owner == null || owner instanceof android.app.Activity) stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
