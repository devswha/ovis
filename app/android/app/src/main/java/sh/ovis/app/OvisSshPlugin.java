package sh.ovis.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.webkit.CookieManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.List;
import java.util.Locale;

/**
 * PCs added over SSH. Capacitor loads its plugins before the WebView's first page, so when the PC
 * about to open is an SSH PC its tunnel already listens on that page's address (SshTunnel). The
 * connect screen's "Add over SSH" opens SshSetupActivity through `add`.
 */
@CapacitorPlugin(name = "OvisSsh")
public class OvisSshPlugin extends Plugin {
    private AlertDialog shown;

    @Override
    public void load() {
        forgetRemoved();
        SshTunnel.listener = this::showStop;
        // every saved SSH PC listens (SSH itself waits for a request): the connect screen checks a PC it opens
        for (SshPcs.Pc pc : SshPcs.list(getContext())) {
            setGate(pc);
            try {
                SshTunnel.open(getContext(), pc);
            } catch (IOException taken) {
                if (pc.origin.equals(PCStore.current(getContext()))) {
                    PCStore.fail(text("This phone could not listen on " + pc.loopbackHost() + ":" + SshPcs.LOCAL_PORT + " for this PC: " + taken.getMessage(), "이 PC를 위한 주소(" + pc.loopbackHost() + ":" + SshPcs.LOCAL_PORT + ")를 휴대폰에서 열 수 없습니다: " + taken.getMessage()), null);
                }
            }
        }
    }

    @Override
    protected void handleOnResume() {
        SshTunnel.wakeAll();
    }

    @PluginMethod
    public void add(PluginCall call) {
        startActivityForResult(call, new Intent(getContext(), SshSetupActivity.class), "added");
    }

    @ActivityCallback
    private void added(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject answer = new JSObject();
        answer.put("added", result.getResultCode() == Activity.RESULT_OK);
        call.resolve(answer);
        if (result.getResultCode() == Activity.RESULT_OK) getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }

    /** The WebView's pass to the tunnel: an HttpOnly cookie on the PC's own loopback origin, which no page script or other app reads. */
    static void setGate(SshPcs.Pc pc) {
        CookieManager cookies = CookieManager.getInstance();
        cookies.setCookie(pc.origin, SshTunnel.GATE_COOKIE + "=" + pc.gate + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000");
        cookies.flush();
    }

    /** An SSH PC forgotten on the connect screen takes its saved way in (host key, sealed key) with it. */
    private void forgetRemoved() {
        List<String> saved = PCStore.saved(getContext());
        String current = PCStore.current(getContext());
        String last = PCStore.last(getContext());
        for (SshPcs.Pc pc : SshPcs.list(getContext())) {
            if (saved.contains(pc.origin) || pc.origin.equals(current) || pc.origin.equals(last)) continue;
            SshPcs.remove(getContext(), pc.origin);
            SshTunnel.closeFor(pc.origin);
        }
    }

    private static boolean korean() {
        return "ko".equals(Locale.getDefault().getLanguage());
    }

    private static String text(String en, String ko) {
        return korean() ? ko : en;
    }

    /**
     * What stopped the tunnel, in a dialog over the page: a changed host key, a refused key, or no Ovis
     * there. A changed host key has no way past it here: only forgetting the PC and adding it again,
     * which shows the new fingerprint to confirm.
     */
    private void showStop(SshPcs.Pc pc, SshLink.Failure failure) {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed() || (shown != null && shown.isShowing())) return;
            String where = pc.label();
            String title;
            String message;
            switch (failure.kind) {
                case "host-key-changed":
                    title = text("The PC's SSH key changed", "PC의 SSH 키가 바뀌었습니다");
                    message = text(
                        where + " answered with another host key than the one you confirmed when you added it. The machine may have been reinstalled or its SSH keys replaced, or someone may be intercepting the connection. Ovis does not connect.\n\nIf you know why it changed, forget this PC and add it again to check the new fingerprint.",
                        where + "이(가) PC를 추가할 때 확인한 것과 다른 호스트 키로 응답했습니다. 기기를 다시 설치했거나 SSH 키를 바꿨을 수도 있고, 누군가 연결을 가로채고 있을 수도 있습니다. Ovis는 연결하지 않습니다.\n\n바뀐 이유를 안다면 이 PC를 지우고 다시 추가해서 새 지문을 확인하세요."
                    );
                    break;
                case "auth":
                case "key-unreadable":
                    title = text("The PC refused this phone", "PC가 이 휴대폰을 거부했습니다");
                    message = text(
                        where + " did not accept this phone's key. It may have been removed from ~/.ssh/authorized_keys there. Add the PC again.",
                        where + "이(가) 이 휴대폰의 키를 받지 않았습니다. 그쪽 ~/.ssh/authorized_keys에서 지워졌을 수 있습니다. PC를 다시 추가하세요."
                    );
                    break;
                default:
                    title = text("Ovis is not running there", "그 PC에서 Ovis가 실행 중이 아닙니다");
                    message = SshSetupActivity.noOvisMessage(where, failure);
                    break;
            }
            AlertDialog.Builder dialog = new AlertDialog.Builder(activity)
                .setTitle(title)
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton(text("Change PC", "PC 바꾸기"), (d, w) -> ((MainActivity) activity).changePc());
            if (failure.kind.equals("host-key-changed") || failure.kind.equals("auth") || failure.kind.equals("key-unreadable")) {
                dialog.setNegativeButton(text("Forget this PC", "이 PC 지우기"), (d, w) -> {
                    PCStore.forget(activity, pc.origin);
                    SshPcs.remove(activity, pc.origin);
                    SshTunnel.closeFor(pc.origin);
                    ((MainActivity) activity).changePc();
                });
            }
            shown = dialog.show();
        });
    }
}
