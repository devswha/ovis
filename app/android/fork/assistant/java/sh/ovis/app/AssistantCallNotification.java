package sh.ovis.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import androidx.core.app.NotificationCompat;

/** While the assistant window is visible, keep the microphone notification in the shade only. */
final class AssistantCallNotification {
    static final String CHANNEL = "live-call-overlay";

    private AssistantCallNotification() {}

    static void createChannel(NotificationManager manager, String title) {
        NotificationChannel channel = new NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_LOW);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(channel);
    }

    static void quiet(NotificationCompat.Builder notification, String title) {
        notification.setContentTitle(title).setVisibility(NotificationCompat.VISIBILITY_SECRET);
    }
}
