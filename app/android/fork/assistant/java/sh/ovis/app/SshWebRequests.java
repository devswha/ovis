package sh.ovis.app;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.util.function.IntFunction;

/** The same tunnel-cookie boundary for every WebView that loads an SSH PC. */
final class SshWebRequests {
    private SshWebRequests() {}

    static WebResourceResponse blocked(WebResourceRequest request) {
        return blocked(request.getUrl().toString(), status -> new WebResourceResponse(
            "text/plain", "utf-8", status, "Forbidden", null, new ByteArrayInputStream(new byte[0])));
    }

    static <T> T blocked(String url, IntFunction<T> response) {
        return SshPcs.otherLoopbackPort(url) ? response.apply(403) : null;
    }
}
