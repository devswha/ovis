package sh.ovis.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.trilead.ssh2.Connection;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Adds a PC over SSH: address and account, then how the phone signs in (its own key, shown to paste
 * into authorized_keys; a password used once to add that key there, as Ovis on a PC registers its own
 * key; or a private key pasted in). The host key's fingerprint is shown and confirmed before anything
 * is sent to the machine. The PC's Ovis is found (or started) as SshLink does, and checked to answer
 * as Ovis; then the PC opens.
 */
public class SshSetupActivity extends Activity {
    private static final int BACKGROUND = Color.parseColor("#12100e");
    private static final int TEXT = Color.parseColor("#d8d0c3");
    private static final int MUTED = Color.parseColor("#9a9184");
    private static final int ACCENT = Color.parseColor("#f0a830");
    private static final int FIELD = Color.parseColor("#1d1a16");

    private EditText host;
    private EditText port;
    private EditText user;
    private RadioGroup method;
    private View phoneKeyPanel;
    private View passwordPanel;
    private View importPanel;
    private EditText password;
    private EditText privateKey;
    private EditText passphrase;
    private TextView status;
    private ProgressBar spinner;
    private Button connect;
    private final AtomicBoolean busy = new AtomicBoolean();
    private int phoneKeyId;
    private int passwordId;

    static boolean korean() {
        return "ko".equals(Locale.getDefault().getLanguage());
    }

    static String text(String en, String ko) {
        return korean() ? ko : en;
    }

    static String noOvisMessage(String where, SshLink.Failure failure) {
        if (failure.kind.equals("unsupported")) return text("Only Linux and macOS machines can be opened from the phone for now.", "지금은 Linux와 macOS 기기만 휴대폰에서 열 수 있습니다.");
        if (failure.kind.equals("not-started")) return text("Ovis is installed on " + where + " but did not start within 30 seconds. Start it there, then try again.", where + "에 Ovis가 설치되어 있지만 30초 안에 시작되지 않았습니다. 그쪽에서 시작한 뒤 다시 시도하세요.");
        String bridge = "bridge-only".equals(failure.getMessage())
            ? text(" Only a bridge another PC's Ovis started runs there; it serves that PC alone.", " 그곳에는 다른 PC의 Ovis가 띄운 브리지만 있고, 그 브리지는 그 PC에만 응답합니다.")
            : "";
        return text(
            "Ovis is not installed for this account on " + where + "." + bridge + " Install it there, in a terminal on that machine:\n\n" + SshLink.INSTALL_COMMAND + "\n\nThen add the PC again.",
            where + "의 이 계정에는 Ovis가 설치되어 있지 않습니다." + bridge + " 그 기기의 터미널에서 설치하세요:\n\n" + SshLink.INSTALL_COMMAND + "\n\n그다음 PC를 다시 추가하세요."
        );
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BACKGROUND);
        getWindow().setNavigationBarColor(BACKGROUND);
        float density = getResources().getDisplayMetrics().density;
        int pad = Math.round(20 * density);

        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(pad, pad, pad, pad);

        form.addView(heading(text("Add a PC over SSH", "SSH로 PC 추가")));
        form.addView(note(text(
            "For a machine you already reach over SSH. The phone connects straight to it: no relay, no account, no port but SSH. Ovis must be installed there.",
            "이미 SSH로 접속하는 기기용입니다. 휴대폰이 그 기기에 바로 연결합니다. 릴레이도 계정도 없고, SSH 말고는 포트를 열지 않습니다. 그 기기에 Ovis가 설치되어 있어야 합니다."
        )));
        host = field(form, text("Address (host name or IP)", "주소(호스트 이름 또는 IP)"), "my-server.example.com", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        port = field(form, text("SSH port", "SSH 포트"), "22", InputType.TYPE_CLASS_NUMBER);
        port.setText("22");
        user = field(form, text("User", "사용자"), "me", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);

        form.addView(label(text("Sign in with", "로그인 방법")));
        method = new RadioGroup(this);
        RadioButton phoneKey = radio(text("This phone's own key (recommended)", "이 휴대폰의 키(권장)"));
        RadioButton passwordOnce = radio(text("Password, once: the phone adds its key there", "비밀번호 한 번: 휴대폰이 그쪽에 자기 키를 추가"));
        RadioButton imported = radio(text("A private key I paste in", "붙여 넣는 개인 키"));
        method.addView(phoneKey);
        method.addView(passwordOnce);
        method.addView(imported);
        phoneKeyId = phoneKey.getId();
        passwordId = passwordOnce.getId();
        form.addView(method);

        LinearLayout keyPanel = panel();
        keyPanel.addView(note(text("Add this line to ~/.ssh/authorized_keys on that machine:", "그 기기의 ~/.ssh/authorized_keys에 이 줄을 추가하세요:")));
        TextView keyLine = new TextView(this);
        keyLine.setTypeface(Typeface.MONOSPACE);
        keyLine.setTextColor(TEXT);
        keyLine.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        keyLine.setTextIsSelectable(true);
        keyLine.setBackgroundColor(FIELD);
        keyLine.setPadding(pad / 2, pad / 2, pad / 2, pad / 2);
        keyPanel.addView(keyLine);
        Button copy = button(text("Copy", "복사"), false);
        keyPanel.addView(copy);
        phoneKeyPanel = keyPanel;
        form.addView(keyPanel);
        new Thread(() -> {
            String line;
            try {
                line = SshPcs.phoneKeyLine(getApplicationContext());
            } catch (Exception failed) {
                line = text("This phone could not make its key: ", "휴대폰이 키를 만들지 못했습니다: ") + SshLink.rootMessage(failed);
            }
            String shown = line;
            runOnUiThread(() -> keyLine.setText(shown));
        }, "ovis-ssh-key").start();
        copy.setOnClickListener(v -> {
            ClipboardManager clipboard = getSystemService(ClipboardManager.class);
            if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("ssh key", keyLine.getText()));
        });

        LinearLayout passPanel = panel();
        password = field(passPanel, text("Password (used once, never saved)", "비밀번호(한 번만 쓰고 저장하지 않음)"), "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passwordPanel = passPanel;
        form.addView(passPanel);

        LinearLayout pastePanel = panel();
        privateKey = field(pastePanel, text("Private key (OpenSSH or PEM)", "개인 키(OpenSSH 또는 PEM)"), "-----BEGIN OPENSSH PRIVATE KEY-----", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        privateKey.setMinLines(4);
        privateKey.setTypeface(Typeface.MONOSPACE);
        passphrase = field(pastePanel, text("Passphrase, if it has one", "암호 문구(있다면)"), "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        pastePanel.addView(note(text("The key is sealed with a key in this phone's Keystore and never leaves the app.", "키는 이 휴대폰 Keystore의 키로 봉인되고 앱 밖으로 나가지 않습니다.")));
        importPanel = pastePanel;
        form.addView(pastePanel);

        method.setOnCheckedChangeListener((group, checked) -> showPanel(checked));
        method.check(phoneKeyId);

        LinearLayout statusRow = new LinearLayout(this);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        spinner = new ProgressBar(this);
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        spinner.setVisibility(View.GONE);
        status = new TextView(this);
        status.setTextColor(TEXT);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        status.setTextIsSelectable(true);
        status.setPadding(pad / 2, pad / 2, 0, pad / 2);
        statusRow.addView(spinner, new LinearLayout.LayoutParams(Math.round(28 * density), Math.round(28 * density)));
        statusRow.addView(status, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        form.addView(statusRow);

        LinearLayout buttons = new LinearLayout(this);
        connect = button(text("Connect", "연결"), true);
        Button cancel = button(text("Cancel", "취소"), false);
        buttons.addView(connect);
        buttons.addView(cancel);
        form.addView(buttons);
        connect.setOnClickListener(v -> start());
        cancel.setOnClickListener(v -> finish());

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BACKGROUND);
        scroll.setFillViewport(true);
        scroll.addView(form);
        ViewCompat.setOnApplyWindowInsetsListener(scroll, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(scroll);
    }

    private void showPanel(int checked) {
        phoneKeyPanel.setVisibility(checked == phoneKeyId ? View.VISIBLE : View.GONE);
        passwordPanel.setVisibility(checked == passwordId ? View.VISIBLE : View.GONE);
        importPanel.setVisibility(checked != phoneKeyId && checked != passwordId ? View.VISIBLE : View.GONE);
    }

    private TextView heading(String words) {
        TextView view = new TextView(this);
        view.setText(words);
        view.setTextColor(Color.parseColor("#f2ebdf"));
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private TextView note(String words) {
        TextView view = new TextView(this);
        view.setText(words);
        view.setTextColor(MUTED);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        view.setPadding(0, dp(6), 0, dp(6));
        return view;
    }

    private TextView label(String words) {
        TextView view = new TextView(this);
        view.setText(words);
        view.setTextColor(TEXT);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        view.setPadding(0, dp(12), 0, dp(4));
        return view;
    }

    private EditText field(LinearLayout parent, String labelText, String hint, int type) {
        parent.addView(label(labelText));
        EditText input = new EditText(this);
        input.setInputType(type);
        input.setHint(hint);
        input.setHintTextColor(Color.parseColor("#5d564d"));
        input.setTextColor(Color.parseColor("#f2ebdf"));
        input.setBackgroundColor(FIELD);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        parent.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return input;
    }

    private RadioButton radio(String words) {
        RadioButton button = new RadioButton(this);
        button.setId(View.generateViewId());
        button.setText(words);
        button.setTextColor(TEXT);
        button.setButtonTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        return button;
    }

    private LinearLayout panel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(0, dp(4), 0, dp(4));
        return panel;
    }

    private Button button(String words, boolean primary) {
        Button button = new Button(this);
        button.setText(words);
        button.setAllCaps(false);
        button.setTextColor(primary ? Color.parseColor("#12100e") : Color.parseColor("#f2ebdf"));
        button.setBackgroundColor(primary ? ACCENT : Color.parseColor("#181613"));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(8), dp(12), 0);
        button.setLayoutParams(params);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void say(String words, boolean working) {
        runOnUiThread(() -> {
            status.setText(words);
            spinner.setVisibility(working ? View.VISIBLE : View.GONE);
            connect.setEnabled(!working);
        });
    }

    private void start() {
        String address = host.getText().toString().trim();
        String account = user.getText().toString().trim();
        int sshPort;
        try {
            sshPort = Integer.parseInt(port.getText().toString().trim());
        } catch (NumberFormatException notNumber) {
            sshPort = -1;
        }
        if (address.isEmpty() || account.isEmpty() || sshPort < 1 || sshPort > 65535 || address.contains(" ") || account.contains(" ")) {
            say(text("Fill in the address, a port from 1 to 65535 and the user.", "주소, 1~65535 사이의 포트, 사용자를 입력하세요."), false);
            return;
        }
        if (!busy.compareAndSet(false, true)) return;
        int checked = method.getCheckedRadioButtonId();
        String how = checked == phoneKeyId ? "phone-key" : checked == passwordId ? "password" : "imported";
        String secret = how.equals("password") ? password.getText().toString() : how.equals("imported") ? privateKey.getText().toString().trim() : null;
        String secretPassphrase = passphrase.getText().toString();
        int finalPort = sshPort;
        new Thread(() -> {
            try {
                add(address, finalPort, account, how, secret, secretPassphrase);
            } finally {
                busy.set(false);
            }
        }, "ovis-ssh-add").start();
    }

    private void add(String address, int sshPort, String account, String how, String secret, String secretPassphrase) {
        String where = account + "@" + address + (sshPort == 22 ? "" : ":" + sshPort);
        say(text("Connecting to " + address + "…", address + "에 연결하는 중…"), true);
        SshLink.HostKeyCheck first = new SshLink.HostKeyCheck(null, null);
        try {
            SshLink.connect(address, sshPort, first).close();
            say(text("The machine did not show a host key.", "기기가 호스트 키를 보여주지 않았습니다."), false);
            return;
        } catch (SshLink.Failure failed) {
            if (!failed.kind.equals("unknown-host")) {
                say(text("Could not reach " + address + ":" + sshPort + ": ", address + ":" + sshPort + "에 연결하지 못했습니다: ") + failed.getMessage(), false);
                return;
            }
        }
        String algorithm = first.seenAlgorithm;
        String hostKey = android.util.Base64.encodeToString(first.seenKey, android.util.Base64.NO_WRAP);
        SshPcs.Pc before = SshPcs.find(this, address, sshPort, account);
        boolean differs = before != null && !(before.hostKey.equals(hostKey) && before.hostKeyAlgorithm.equals(algorithm));
        if (!confirmHostKey(address, algorithm, SshLink.fingerprint(first.seenKey), differs)) {
            say(text("Not connected: the host key was not confirmed.", "연결하지 않았습니다: 호스트 키를 확인하지 않았습니다."), false);
            return;
        }

        Connection connection = null;
        try {
            say(text("Signing in as " + account + "…", account + "(으)로 로그인하는 중…"), true);
            connection = SshLink.connect(address, sshPort, new SshLink.HostKeyCheck(algorithm, hostKey));
            String sealedKey = "";
            String sealedPassphrase = "";
            String saveAs = how;
            if (how.equals("phone-key")) {
                SshLink.signInWithKey(connection, account, SshPcs.phoneKey(this));
            } else if (how.equals("imported")) {
                SshLink.signInWithImported(connection, account, secret, secretPassphrase.isEmpty() ? null : secretPassphrase);
                sealedKey = SshVault.sealText(secret);
                sealedPassphrase = secretPassphrase.isEmpty() ? "" : SshVault.sealText(secretPassphrase);
            } else {
                SshLink.signInWithPassword(connection, account, secret);
                say(text("Adding this phone's key to " + where + "…", where + "에 이 휴대폰의 키를 추가하는 중…"), true);
                SshLink.authorizeKey(connection, SshPcs.phoneKeyLine(this));
                connection.close();
                // the key, not the password, is what reconnects: prove it works before the password is gone
                connection = SshLink.connect(address, sshPort, new SshLink.HostKeyCheck(algorithm, hostKey));
                SshLink.signInWithKey(connection, account, SshPcs.phoneKey(this));
                saveAs = "phone-key";
            }
            runOnUiThread(() -> password.setText(""));

            say(text("Looking for Ovis on " + address + "…", address + "에서 Ovis를 찾는 중…"), true);
            int ovisPort = SshLink.ovisPort(connection);
            if (!SshLink.answersAsOvis(connection, ovisPort)) {
                say(text("Something answers on that machine's Ovis port, but not as Ovis.", "그 기기의 Ovis 포트에서 응답이 있지만 Ovis가 아닙니다."), false);
                return;
            }

            SshPcs.Pc pc = before != null ? before : new SshPcs.Pc();
            if (before == null) {
                pc.origin = SshPcs.freeOrigin(this);
                pc.gate = SshPcs.newGate();
            }
            pc.host = address;
            pc.port = sshPort;
            pc.user = account;
            pc.hostKeyAlgorithm = algorithm;
            pc.hostKey = hostKey;
            pc.auth = saveAs;
            pc.importedKey = sealedKey;
            pc.importedPassphrase = sealedPassphrase;
            SshPcs.put(this, pc);
            SshTunnel.closeFor(pc.origin);
            OvisSshPlugin.setGate(pc);
            PCStore.setName(this, pc.origin, where + " (SSH)");
            PCStore.open(this, pc.origin, pc.origin + "/");
            PCStore.fail(null, null);
            say(text("Connected. Opening Ovis…", "연결했습니다. Ovis를 여는 중…"), true);
            runOnUiThread(() -> {
                setResult(RESULT_OK);
                finish();
            });
        } catch (SshLink.Failure failed) {
            say(describe(where, failed), false);
        } catch (Exception unexpected) {
            say(text("Could not add the PC: ", "PC를 추가하지 못했습니다: ") + SshLink.rootMessage(unexpected), false);
        } finally {
            if (connection != null) connection.close();
        }
    }

    private static String describe(String where, SshLink.Failure failed) {
        switch (failed.kind) {
            case "auth":
                return text(
                    where + " refused it: " + failed.getMessage() + ". With this phone's key, add the line above to ~/.ssh/authorized_keys there first, or use the password once.",
                    where + "이(가) 거부했습니다: " + failed.getMessage() + ". 이 휴대폰의 키를 쓰려면 위의 줄을 먼저 그쪽 ~/.ssh/authorized_keys에 추가하거나, 비밀번호를 한 번 쓰세요."
                );
            case "key-unreadable":
                return text("That private key could not be read: " + failed.getMessage() + ". Check the passphrase.", "그 개인 키를 읽지 못했습니다: " + failed.getMessage() + ". 암호 문구를 확인하세요.");
            case "host-key-changed":
                return text("The host key changed while connecting. Nothing was sent; try again and check the fingerprint.", "연결하는 사이에 호스트 키가 바뀌었습니다. 아무것도 보내지 않았습니다. 다시 시도하고 지문을 확인하세요.");
            case "no-ovis":
            case "not-started":
            case "unsupported":
                return noOvisMessage(where, failed);
            default:
                return text("Could not finish: ", "끝내지 못했습니다: ") + failed.getMessage();
        }
    }

    /** Asks on the main thread whether the fingerprint is the machine's, and waits for the answer. */
    private boolean confirmHostKey(String address, String algorithm, String fingerprint, boolean differs) {
        CountDownLatch answered = new CountDownLatch(1);
        AtomicBoolean trusted = new AtomicBoolean();
        runOnUiThread(() -> {
            String warning = differs ? text("\n\nThis is NOT the key this phone saw for this PC before.", "\n\n이 휴대폰이 전에 이 PC에서 본 키가 아닙니다.") : "";
            new AlertDialog.Builder(this)
                .setTitle(text("Is this " + address + "?", "이 기기가 " + address + "인가요?"))
                .setMessage(text(
                    "Its host key fingerprint:\n\n" + algorithm + "\n" + fingerprint + "\n\nCheck it on that machine with\nssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\nand trust it only if it matches.",
                    "호스트 키 지문:\n\n" + algorithm + "\n" + fingerprint + "\n\n그 기기에서\nssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\n로 확인하고, 같을 때만 신뢰하세요."
                ) + warning)
                .setCancelable(false)
                .setPositiveButton(text("Trust and connect", "신뢰하고 연결"), (d, w) -> {
                    trusted.set(true);
                    answered.countDown();
                })
                .setNegativeButton(text("Cancel", "취소"), (d, w) -> answered.countDown())
                .show();
        });
        try {
            answered.await();
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
            return false;
        }
        return trusted.get();
    }
}
