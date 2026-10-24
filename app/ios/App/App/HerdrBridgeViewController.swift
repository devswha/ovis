import UIKit
import WebKit
import Capacitor

/// The PCs this app knows, kept in UserDefaults. The WebView's cookies (a paired device's
/// sign-in) live in WebKit's own store, not here.
enum PCStore {
    private static let defaults = UserDefaults.standard

    /// Origins opened before, the latest first.
    static var saved: [String] {
        get { defaults.stringArray(forKey: "herdr.saved") ?? [] }
        set { defaults.set(newValue, forKey: "herdr.saved") }
    }

    /// The PC the app opens at launch, an origin; nil shows the connect screen.
    static var current: String? {
        get { defaults.string(forKey: "herdr.current") }
        set { defaults.set(newValue, forKey: "herdr.current") }
    }

    /// The PC opened last, even after "Change PC", for the pages that name it.
    static var last: String? {
        get { defaults.string(forKey: "herdr.last") }
        set { defaults.set(newValue, forKey: "herdr.last") }
    }

    /// The address to open instead of the bare origin until a PC page loads: a pairing link keeps
    /// its `?pair=` code through Try again. In memory only, as it can hold that code.
    static var pendingStart: String?

    /// Why the last load failed, for the error page.
    static var failure: String?

    static func remember(_ origin: String) {
        saved = [origin] + saved.filter { $0 != origin }
    }

    static func forget(_ origin: String) {
        saved = saved.filter { $0 != origin }
        if current == origin { current = nil }
        if last == origin { last = nil }
    }

    /// `scheme://host[:port]` of an http or https URL, the host in lowercase as WebKit reports it, or nil.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        return url.port.map { "\(scheme)://\(shownHost):\($0)" } ?? "\(scheme)://\(shownHost)"
    }
}

/// Capacitor's view controller with the chosen PC as the WebView's first page. Reaching the PC
/// by navigating from the bundled connect page instead would cost every launch about 1.5 s
/// (docs/native-app.md, Spike results), so opening a PC builds a new one of these.
class HerdrBridgeViewController: CAPBridgeViewController {
    private var failureProxy: NavigationFailureProxy?
    /// Covers the web view, which stays blank until the PC's page has loaded.
    private var openingView: UIView?
    /// Gives up on a PC that has not answered, instead of WebKit's own wait of a minute or more.
    private var answerTimeout: DispatchWorkItem?
    /// The cover's spinner, text and Try again, which change when the PC does not open in time.
    private var openingSpinner: UIActivityIndicatorView?
    private var openingLabel: UILabel?
    private var openingRetry: UIButton?
    /// A page has finished loading in this one: later failures are left to the page.
    private var firstPageDone = false
    /// How long a PC may take to answer the first request.
    private static let answerSeconds = 20

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let origin = PCStore.current, let host = URL(string: origin)?.host {
            // what server.url sets; the pairing link until a PC page has loaded, the origin after it
            descriptor.serverURL = PCStore.pendingStart ?? origin + "/"
            // the whole PC is the app: its own links stay in the WebView, others go to Safari
            descriptor.allowedNavigationHostnames = descriptor.allowedNavigationHostnames + [host]
        }
        return descriptor
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // a PC on a plain http address (a tailnet or LAN IP) is opened as typed: with the system's
        // https-first try, every load of one waited about 2 s before it started
        configuration.upgradeKnownHostsToHTTPS = false
        if #available(iOS 18.2, *) {
            configuration.defaultWebpagePreferences.preferredHTTPSNavigationPolicy = .keepAsRequested
        }
        return configuration
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HerdrShellPlugin())
        bridge?.registerPluginInstance(OvisPushPlugin())
    }

    override func viewDidLoad() {
        // before super, which starts the first load
        if let webView = webView, PCStore.current != nil {
            let proxy = NavigationFailureProxy(inner: webView.navigationDelegate) { [weak self] webView, reason in
                self?.showFailure(in: webView, reason: reason)
            }
            // the PC answered: WebKit shows its page from here, as it did before the cover existed
            proxy.onAnswer = { [weak self] in self?.hideOpening() }
            proxy.onLoaded = { [weak self] in
                self?.firstPageDone = true
                self?.hideOpening()
            }
            // a first page that broke off after it started: the error page; one cancelled on purpose
            // leaves the cover up, which the timeout turns into Try again. Only the PC's answer or a
            // finished page takes the cover away: while a PC's connection hangs, WebKit showed
            // error.html half-loaded, its script not run and its buttons dead.
            proxy.onPageFailed = { [weak self] webView, reason in
                // the PC's first page only (the cover may be gone once the PC answered), never the
                // bundled error page, which would load itself again
                guard let self, !self.firstPageDone, let reason,
                      ["http", "https"].contains(webView.url?.scheme?.lowercased() ?? "") else { return }
                self.showFailure(in: webView, reason: reason)
            }
            failureProxy = proxy
            webView.navigationDelegate = proxy
        }
        super.viewDidLoad()
        if let webView = webView, let origin = PCStore.current {
            showOpening(origin)
            let timeout = DispatchWorkItem { [weak self, weak webView] in
                // said on the cover itself: while the PC's connection hangs, WebKit did not show the
                // error page either (it stayed unpainted), in this web view or a new one
                webView?.stopLoading()
                self?.showNoAnswer(origin)
            }
            answerTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(Self.answerSeconds), execute: timeout)
        }
    }

    deinit { answerTimeout?.cancel() }

    private static var korean: Bool { Locale.preferredLanguages.first?.lowercased().hasPrefix("ko") ?? false }

    /// What shows while a PC opens: which PC, and Change PC, so a PC that never answers does not
    /// leave a blank screen.
    private func showOpening(_ origin: String) {
        let host = URL(string: origin)?.host ?? origin
        let cover = UIView(frame: view.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = UIColor(red: 0x12 / 255, green: 0x10 / 255, blue: 0x0e / 255, alpha: 1)

        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.startAnimating()
        let label = UILabel()
        label.text = Self.korean ? "\(host) 여는 중…" : "Opening \(host)…"
        label.textColor = UIColor(white: 0.85, alpha: 1)
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.textAlignment = .center
        let change = UIButton(type: .system, primaryAction: UIAction(title: Self.korean ? "PC 바꾸기" : "Change PC") { _ in
            PCStore.current = nil
            HerdrBridgeViewController.reopen()
        })
        change.tintColor = .white
        change.titleLabel?.font = .preferredFont(forTextStyle: .body)
        let retry = UIButton(type: .system, primaryAction: UIAction(title: Self.korean ? "다시 시도" : "Try again") { _ in
            PCStore.failure = nil
            HerdrBridgeViewController.reopen()
        })
        retry.tintColor = UIColor(red: 0xf0 / 255, green: 0xa8 / 255, blue: 0x30 / 255, alpha: 1)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.isHidden = true

        let stack = UIStackView(arrangedSubviews: [spinner, label, retry, change])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        // scrolls when large text makes it taller than the screen, so both buttons stay reachable
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = false
        scroll.addSubview(stack)
        cover.addSubview(scroll)
        let content = scroll.contentLayoutGuide, frame = scroll.frameLayoutGuide
        // the content is the screen's height, or taller when the text needs it, with the stack centered
        let fill = content.heightAnchor.constraint(equalTo: frame.heightAnchor)
        fill.priority = .defaultLow
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: cover.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: cover.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: cover.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: cover.safeAreaLayoutGuide.trailingAnchor),
            content.widthAnchor.constraint(equalTo: frame.widthAnchor),
            content.heightAnchor.constraint(greaterThanOrEqualTo: frame.heightAnchor),
            fill,
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24)
        ])
        view.addSubview(cover)
        openingView = cover
        openingSpinner = spinner
        openingLabel = label
        openingRetry = retry
    }

    /// The cover once the PC has not answered in time: why, what to check, Try again and Change PC.
    private func showNoAnswer(_ origin: String) {
        let host = URL(string: origin)?.host ?? origin
        // a load that already failed keeps its reason
        var text = PCStore.failure.map { "\(host): \($0)" } ?? (Self.korean
            ? "\(host)이(가) \(Self.answerSeconds)초 안에 응답하지 않았습니다."
            : "\(host) did not answer within \(Self.answerSeconds) seconds.")
        if Self.tailnet(host) {
            text += Self.korean
                ? "\n\nTailscale 주소입니다. 이 휴대폰에서 Tailscale이 꺼져 있을 수 있습니다. Tailscale 앱에서 연결을 켠 뒤 다시 시도를 누르세요."
                : "\n\nThis is a Tailscale address, and Tailscale may be off on this phone. Turn it on in the Tailscale app, then tap Try again."
        } else {
            text += Self.korean
                ? "\n\nPC가 켜져 있는지, 거기서 Ovis가 실행 중인지, 이 휴대폰이 PC에 닿을 수 있는지 확인하세요."
                : "\n\nCheck that the PC is on, that Ovis runs there, and that this phone can reach it."
        }
        openingSpinner?.stopAnimating()
        openingSpinner?.isHidden = true
        openingLabel?.text = text
        openingRetry?.isHidden = false
    }

    /// A MagicDNS name or a Tailscale IP (100.64.0.0/10, fd7a:115c:a1e0::/48), which opens only
    /// while Tailscale is connected on the phone; error.html has the same test.
    private static func tailnet(_ host: String) -> Bool {
        let name = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if name.hasSuffix(".ts.net") || name.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = name.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
    }

    private func hideOpening() {
        answerTimeout?.cancel()
        openingView?.removeFromSuperview()
        openingView = nil
    }

    private func showFailure(in webView: WKWebView, reason: String) {
        guard let local = bridge?.config.localURL else { return }
        // the timeout stays armed: if WebKit does not get the error page up either, the cover says it
        PCStore.failure = reason
        webView.load(URLRequest(url: local.appendingPathComponent("error.html")))
    }

    /// Replaces the app's view controller, so the next page (a PC, or the connect screen) is a
    /// first load. The old one goes with its web view and the page in it (the barcode scanner
    /// plugin, which kept it alive, is patched in app/patches).
    static func reopen() {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let window = (scene?.delegate as? SceneDelegate)?.window else { return }
        window.rootViewController = HerdrBridgeViewController()
    }
}

/// Passes every navigation callback to Capacitor's own delegate and reports a main-frame load
/// that failed, such as a PC that is off or one that answers with an HTTP error, with its reason.
/// A load cancelled on purpose (a link handed to Safari, a new navigation) is not a failure.
final class NavigationFailureProxy: NSObject, WKNavigationDelegate {
    private weak var inner: WKNavigationDelegate?
    private let onFailure: (WKWebView, String) -> Void
    /// The PC itself answered the first page (http or https), with any status.
    var onAnswer: (() -> Void)?
    /// A page (the PC's or the error page) finished loading.
    var onLoaded: (() -> Void)?
    /// A page broke off after it started loading, with the reason, or nil when that was on purpose.
    var onPageFailed: ((WKWebView, String?) -> Void)?

    /// Whether a failed load was cancelled or handed off on purpose: a new navigation, WebKit's
    /// "frame load interrupted" (102) or "plug-in handled load" (204).
    private static func onPurpose(_ error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return true }
        return nsError.domain == "WebKitErrorDomain" && (nsError.code == 102 || nsError.code == 204)
    }

    init(inner: WKNavigationDelegate?, onFailure: @escaping (WKWebView, String) -> Void) {
        self.inner = inner
        self.onFailure = onFailure
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner?.responds(to: aSelector) == true ? inner : nil
    }

    /// A main-frame HTTP error (tailscale serve's 502 while Ovis is stopped on the PC, a 404) is
    /// not a PC worth keeping, and its page would leave the app no way back: the error page shows
    /// instead. Capacitor's delegate does not decide responses; WebKit allows all of them.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // the PC's own answer, not the bundled error page's
        if navigationResponse.isForMainFrame, ["http", "https"].contains(navigationResponse.response.url?.scheme?.lowercased() ?? "") { onAnswer?() }
        guard navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
              response.statusCode >= 400 else {
            decisionHandler(.allow)
            return
        }
        // the cancelled load ends in WebKit's "frame load interrupted", which is not reported
        decisionHandler(.cancel)
        onFailure(webView, "HTTP \(response.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: response.statusCode).capitalized)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        inner?.webView?(webView, didFinish: navigation)
        onLoaded?()
        // the PC's page is up: a pairing link has done its work, and the PC is one worth keeping
        if let url = webView.url, let origin = PCStore.origin(of: url), origin == PCStore.current {
            PCStore.pendingStart = nil
            PCStore.remember(origin)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        inner?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        if !Self.onPurpose(error) { onFailure(webView, error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        inner?.webView?(webView, didFail: navigation, withError: error)
        onPageFailed?(webView, Self.onPurpose(error) ? nil : error.localizedDescription)
    }
}
