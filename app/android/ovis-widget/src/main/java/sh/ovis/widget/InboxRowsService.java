package sh.ovis.widget;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import sh.ovis.push.AlertProof;
import sh.ovis.push.FriendIcon;
import sh.ovis.push.OvisMessagingService;

/** The widget's rows, from InboxStore. */
public class InboxRowsService extends RemoteViewsService {
    private static final int WAITING = 0xFFF5A524;
    private static final int DONE = 0xFF4ADE80;
    private static final int WORKING = 0xFF60A5FA;
    private static final int IDLE = 0xFF5C5C5C;
    private static final int TEXT = 0xFFEDEDED;
    private static final int DIM = 0xFF8A8A8A;

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Rows(getApplicationContext());
    }

    static String ago(long seconds) {
        if (seconds < 60) return "now";
        if (seconds < 3600) return (seconds / 60) + "m";
        if (seconds < 86400) return (seconds / 3600) + "h";
        return (seconds / 86400) + "d";
    }

    private static final class Rows implements RemoteViewsFactory {
        private final Context context;
        private List<InboxStore.Row> rows = new ArrayList<>();

        Rows(Context context) {
            this.context = context;
        }

        @Override
        public void onCreate() {}

        @Override
        public void onDataSetChanged() {
            rows = InboxStore.view(context, System.currentTimeMillis() / 1000).rows;
        }

        @Override
        public void onDestroy() {
            rows.clear();
        }

        @Override
        public int getCount() {
            return rows.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.ovis_widget_row);
            if (position >= rows.size()) return views;
            InboxStore.Row held = rows.get(position);
            JSONObject row = held.row;
            long since = Math.max(0, System.currentTimeMillis() / 1000 - row.optLong("t", 0));
            String words = row.optString("d", "");
            String status;
            int color;
            switch (held.status()) {
                case "b": status = context.getString(R.string.ovis_widget_status_waiting); color = WAITING; break;
                case "d": status = context.getString(R.string.ovis_widget_status_done); color = DONE; break;
                case "w": status = context.getString(R.string.ovis_widget_status_working); color = WORKING; break;
                default: status = context.getString(R.string.ovis_widget_status_idle); color = IDLE; break;
            }
            views.setTextViewText(R.id.ovis_widget_name, row.optString("n", ""));
            // the last words as the inbox row shows them; the status word while there are none
            views.setTextViewText(R.id.ovis_widget_status, words.isEmpty() ? status : words);
            views.setTextViewText(R.id.ovis_widget_time, ago(since));
            views.setTextColor(R.id.ovis_widget_name, held.stale ? DIM : TEXT);
            views.setInt(R.id.ovis_widget_dot, "setColorFilter", held.stale ? IDLE : color);
            Bitmap face = FriendIcon.of(context, row.isNull("f") ? null : row.optString("f", null));
            if (face != null) views.setImageViewBitmap(R.id.ovis_widget_face, face);

            String pane = row.optString("p", "");
            String machine = row.optString("m", "");
            String workspace = row.optString("w", "");
            Intent tap = new Intent()
                .putExtra(OvisMessagingService.EXTRA_ORIGIN, held.origin)
                .putExtra(OvisMessagingService.EXTRA_SERVER_ID, held.serverId)
                .putExtra(OvisMessagingService.EXTRA_MACHINE, machine.isEmpty() ? null : machine)
                .putExtra(OvisMessagingService.EXTRA_WORKSPACE, workspace.isEmpty() ? null : workspace)
                .putExtra(OvisMessagingService.EXTRA_PANE, pane)
                .putExtra(AlertProof.EXTRA, held.proof)
                .setData(Uri.fromParts("ovis-widget", held.origin + " " + machine + " " + pane, null));
            views.setOnClickFillInIntent(R.id.ovis_widget_row, tap);
            return views;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return false;
        }
    }
}
