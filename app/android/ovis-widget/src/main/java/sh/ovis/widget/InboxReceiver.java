package sh.ovis.widget;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import org.json.JSONException;
import sh.ovis.push.AlertProof;
import sh.ovis.push.OvisMessagingService;

/** A digest OvisMessagingService decrypted: kept, and every placed widget drawn again. Not exported. */
public class InboxReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String digest = intent.getStringExtra(OvisMessagingService.EXTRA_INBOX);
        if (digest == null) return;
        try {
            InboxStore.keep(context, digest, intent.getStringExtra(OvisMessagingService.EXTRA_ORIGIN), intent.getStringExtra(AlertProof.EXTRA));
        } catch (JSONException e) {
            Log.w("OvisWidget", "a digest could not be read");
            return;
        }
        InboxWidget.refresh(context);
    }
}
