package sh.ovis.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;
import sh.ovis.push.OvisMessagingService;

/**
 * The home-screen widget: every agent of the PCs that push to this phone, the ones waiting on you
 * first. A row opens its pane as an alert's tap does; with no agents to show, the widget opens the app.
 */
public class InboxWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, views(context, id));
        manager.notifyAppWidgetViewDataChanged(ids, R.id.ovis_widget_list);
    }

    static int[] ids(Context context) {
        return AppWidgetManager.getInstance(context).getAppWidgetIds(new ComponentName(context, InboxWidget.class));
    }

    static void refresh(Context context) {
        int[] ids = ids(context);
        if (ids.length == 0) return;
        new InboxWidget().onUpdate(context, AppWidgetManager.getInstance(context), ids);
    }

    private static RemoteViews views(Context context, int id) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.ovis_widget_inbox);
        InboxStore.View view = InboxStore.view(context, System.currentTimeMillis() / 1000);
        Intent rows = new Intent(context, InboxRowsService.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        rows.setData(Uri.parse(rows.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.ovis_widget_list, rows);
        views.setEmptyView(R.id.ovis_widget_list, R.id.ovis_widget_empty);
        views.setTextViewText(R.id.ovis_widget_empty, context.getString(view.any ? R.string.ovis_widget_none : R.string.ovis_widget_empty));

        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            PendingIntent open = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            views.setOnClickPendingIntent(R.id.ovis_widget_empty, open);
            // each row fills in its pane (InboxRowsService), as an alert's tap names it
            Intent alert = new Intent(launch).setAction(OvisMessagingService.ACTION_OPEN_ALERT);
            views.setPendingIntentTemplate(R.id.ovis_widget_list,
                PendingIntent.getActivity(context, 1, alert, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        return views;
    }
}
