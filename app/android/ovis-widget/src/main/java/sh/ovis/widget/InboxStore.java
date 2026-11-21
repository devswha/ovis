package sh.ovis.widget;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The last digest each PC pushed (server/fork/inbox-widget.ts), by the PC's origin, with the proof
 * a tap carries (sh.ovis.push.AlertProof). The widget shows every PC's agents together, in the
 * PC's own order: waiting on you first, the longest wait on top, then finished, working and idle.
 */
final class InboxStore {
    /** a PC not heard from for longer (it pushes every 10 minutes) is shown greyed */
    static final long STALE_S = 25 * 60;
    /** and one not heard from for a day is dropped */
    private static final long FORGET_S = 24 * 60 * 60;
    private static final String PREFS = "ovis_widget";
    private static final String PCS = "pcs";
    private static final String ORDER = "bdwi";

    static final class Row {
        final JSONObject row;
        final String origin;
        final String serverId;
        final String proof;
        final boolean stale;

        Row(JSONObject row, String origin, String serverId, String proof, boolean stale) {
            this.row = row;
            this.origin = origin;
            this.serverId = serverId;
            this.proof = proof;
            this.stale = stale;
        }

        String status() {
            return row.optString("s", "i");
        }
    }

    static final class View {
        final List<Row> rows = new ArrayList<>();
        boolean any;
    }

    private InboxStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject pcs(SharedPreferences prefs) {
        try {
            return new JSONObject(prefs.getString(PCS, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static synchronized void keep(Context context, String digest, String origin, String proof) throws JSONException {
        SharedPreferences prefs = prefs(context);
        JSONObject all = pcs(prefs);
        JSONObject held = new JSONObject().put("digest", new JSONObject(digest)).put("proof", proof == null ? JSONObject.NULL : proof);
        all.put(origin == null ? "" : origin, held);
        prefs.edit().putString(PCS, all.toString()).apply();
    }

    static synchronized View view(Context context, long now) {
        View view = new View();
        JSONObject all = pcs(prefs(context));
        Iterator<String> origins = all.keys();
        while (origins.hasNext()) {
            String origin = origins.next();
            JSONObject held = all.optJSONObject(origin);
            JSONObject digest = held == null ? null : held.optJSONObject("digest");
            if (digest == null) continue;
            long at = digest.optLong("at", 0);
            if (now - at > FORGET_S) continue;
            view.any = true;
            boolean stale = now - at > STALE_S;
            String serverId = digest.optString("server_id", "");
            String proof = held.isNull("proof") ? null : held.optString("proof", null);
            JSONArray rows = digest.optJSONArray("rows");
            for (int index = 0; rows != null && index < rows.length(); index++) {
                JSONObject row = rows.optJSONObject(index);
                if (row == null) continue;
                Row kept = new Row(row, origin.isEmpty() ? null : origin, serverId.isEmpty() ? null : serverId, proof, stale);
                view.rows.add(kept);
            }
        }
        view.rows.sort((a, b) -> {
            int byStatus = rank(a.status()) - rank(b.status());
            if (byStatus != 0) return byStatus;
            long ta = a.row.optLong("t", 0), tb = b.row.optLong("t", 0);
            if (ta != tb) return "b".equals(a.status()) ? Long.compare(ta, tb) : Long.compare(tb, ta);
            return a.row.optString("n", "").compareToIgnoreCase(b.row.optString("n", ""));
        });
        return view;
    }

    private static int rank(String status) {
        int index = ORDER.indexOf(status);
        return index < 0 ? ORDER.length() : index;
    }
}
