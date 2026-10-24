package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.Timeout;

public class PCStoreTest {
    private static final String OVIS = "{\"ok\":true,\"auth\":{\"required\":true,\"authenticated\":false},\"bridge_protocol\":3}";

    /** A probe that never gives up hangs here instead of passing. */
    @Rule
    public final Timeout timeout = Timeout.seconds(20);

    private final List<ServerSocket> servers = new ArrayList<>();

    private final List<String> requestLines = Collections.synchronizedList(new ArrayList<>());

    /** A server on 127.0.0.1 answering every request with `status`, `location` and `body`. */
    private String serve(int status, String location, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " Test\r\n" + (location == null ? "" : "Location: " + location + "\r\n")
            + "Content-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
        return listen(out -> {
            out.write(head.getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
        });
    }

    /** A server that answers 200 and then sends its headers, or its body, one byte at a time, never finishing. */
    private String serveSlowly(boolean headers) throws IOException {
        return listen(out -> {
            String head = headers ? "HTTP/1.1 200 Test\r\nX-Slow: " : "HTTP/1.1 200 Test\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n";
            out.write(head.getBytes(StandardCharsets.UTF_8));
            try {
                while (true) {
                    out.write(headers ? 'a' : ' ');
                    out.flush();
                    Thread.sleep(50);
                }
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
            }
        });
    }

    private interface Answer {
        void write(OutputStream out) throws IOException;
    }

    private String listen(Answer answer) throws IOException {
        ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        servers.add(server);
        Thread thread = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    BufferedReader request = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    requestLines.add(request.readLine());
                    for (String line = request.readLine(); line != null && !line.isEmpty(); line = request.readLine()) { }
                    OutputStream out = socket.getOutputStream();
                    answer.write(out);
                    out.flush();
                } catch (IOException closed) {
                    if (server.isClosed()) return;
                }
            }
        });
        thread.setDaemon(true);
        thread.start();
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    /** An address whose /api/health redirects `redirects` times in a row before it reaches `end`. */
    private String redirecting(int redirects, String end) throws IOException {
        String next = end;
        for (int i = 0; i < redirects; i++) next = serve(302, next + "/api/health?scope=bridge", "");
        return next;
    }

    private static String probe(String target) {
        return PCStore.ovisOrigin(target, PCStore.PROBE_BUDGET_MS);
    }

    @After
    public void stop() throws IOException {
        for (ServerSocket server : servers) server.close();
    }

    @Test
    public void anOriginThatAnswersAsOvisIsOvis() throws IOException {
        String ovis = serve(200, null, OVIS);
        assertEquals(ovis, probe(ovis + "/?pair=123456"));
        assertEquals(Collections.singletonList("GET /api/health?scope=bridge HTTP/1.1"), requestLines);
    }

    @Test
    public void followsRedirectsOfItsQuestionToTheOvisServer() throws IOException {
        String ovis = serve(200, null, OVIS);
        String upgrade = serve(301, ovis + "/api/health?scope=bridge", "");
        assertEquals(ovis, probe(upgrade + "/"));
    }

    @Test
    public void followsAtMostFiveRedirects() throws IOException {
        String ovis = serve(200, null, OVIS);
        assertEquals(ovis, probe(redirecting(PCStore.MAX_REDIRECTS, ovis) + "/"));
        assertNull(probe(redirecting(PCStore.MAX_REDIRECTS + 1, ovis) + "/"));
    }

    @Test
    public void aSignInPageOrAnotherSiteIsNotOvis() throws IOException {
        assertNull(probe(serve(200, null, "<!doctype html><title>Sign in</title>") + "/login"));
        assertNull(probe(serve(200, null, "{\"ok\":true}") + "/"));
        assertNull(probe(serve(200, null, "{\"ok\":true,\"auth\":{}}") + "/"));
        assertNull(probe(serve(200, null, "{\"ok\":\"true\",\"auth\":{},\"bridge_protocol\":3}") + "/"));
        assertNull(probe(serve(401, null, OVIS) + "/"));
        String signIn = serve(200, null, "<!doctype html><title>Sign in</title>");
        assertNull(probe(serve(302, signIn + "/login?next=/", "") + "/"));
    }

    @Test
    public void aLoopIsNotOvis() throws IOException {
        String self = serve(302, "/api/health?scope=bridge", "");
        assertNull(probe(self + "/"));
    }

    @Test
    public void anAnswerThatNeverEndsIsNotOvisOnceTheBudgetIsSpent() throws IOException {
        assertNull(PCStore.ovisOrigin(serveSlowly(false) + "/", 300));
        assertNull(PCStore.ovisOrigin(serveSlowly(true) + "/", 300));
    }

    @Test
    public void anAddressNobodyAnswersOrThatIsNotHttpIsNotOvis() throws IOException {
        ServerSocket closed = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        int port = closed.getLocalPort();
        closed.close();
        assertNull(probe("http://127.0.0.1:" + port + "/"));
        assertNull(probe("intent://scan/#Intent;scheme=zxing;end"));
    }

    @Test
    public void theStartKeepsAPairingLinksCodeOnTheOvisOrigin() {
        assertEquals("https://pc.example.com/?pair=123456", PCStore.startOn("https://pc.example.com", "http://100.64.0.1/?pair=123456"));
        assertEquals("https://pc.example.com/", PCStore.startOn("https://pc.example.com", "http://100.64.0.1"));
    }
}
