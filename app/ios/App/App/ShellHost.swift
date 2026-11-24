import Capacitor
import Foundation
import ObjectiveC
import OvisHomeCore
import UIKit
import WebKit

/// The shell inside the app (docs/native-app.md, The shell inside the app): a build made with OVIS_APP_SHELL=bundled
/// carries the hosted app's files (app/bundled-shell, app/scripts/bundled-shell.ts, copied in by carry-shell.sh) and
/// answers `capacitor://<the hosted origin's host>/…` from them, as the hosted app's host answers the same paths (ShellRoute), with the policy that
/// host sends as a response header: the shell's on every answer, the render host's own on `/s/<id>/~render`.
///
/// Capacitor registers one handler for the app's scheme, sends no header but the type, and has no setting for either
/// (its view controller's loadView is final, and the package is a built framework, so a patch does not reach it). So
/// this stands in front of that handler's one entry point: a request for the shell's host is answered here, one for
/// the app's own pages (`capacitor://localhost`) goes on to Capacitor as it always did, and any other host on the
/// scheme gets nothing. Where that cannot be put in place, or the build's shell or its policies are missing, nothing
/// is the shell (`origin` nil) and no page gets what a shell page may ask: the shell is never served without its policy.
enum ShellHost {
    /// What the build carries (app/scripts/bundled-shell.ts packShell): `shell/`, the files, and `shell-policy.json`,
    /// the two policies of that copy's own `_headers`. A folder of its own, so Capacitor never serves it as the app's
    /// own pages.
    private static let carried = Bundle.main.url(forResource: "bundled-shell", withExtension: nil)
    private static let folder = carried?.appendingPathComponent("shell", isDirectory: true).resolvingSymlinksInPath()
    private static let policies = ShellRoute.policies(carried.flatMap { try? Data(contentsOf: $0.appendingPathComponent("shell-policy.json")) })

    /// Where the shell's pages are in a build that serves them itself, once this stands in front of Capacitor's
    /// handler; nil in a build that loads the shell from the network, and in one that cannot serve its own.
    static let origin: URL? = {
        guard (Bundle.main.object(forInfoDictionaryKey: "OvisAppShell") as? String) == "bundled",
              let origin = Home.shellOrigin(hosted: PCStore.appOrigin, bundled: true), policies != nil, let folder,
              FileManager.default.fileExists(atPath: folder.appendingPathComponent("index.html").path),
              FileManager.default.fileExists(atPath: folder.appendingPathComponent("render.html").path) else { return nil }
        let handler: AnyClass = WebViewAssetHandler.self
        guard let stock = class_getInstanceMethod(handler, #selector(WebViewAssetHandler.webView(_:start:))),
              let own = class_getInstanceMethod(handler, #selector(WebViewAssetHandler.ovisWebView(_:start:))) else { return nil }
        method_exchangeImplementations(stock, own)
        return origin
    }()

    /// Answers a request for the shell's host, start to finish before it returns, so the task cannot have been
    /// stopped in between (a task answered after it stopped raises).
    fileprivate static func answer(_ task: WKURLSchemeTask) {
        guard let url = task.request.url, let policies, let folder else {
            task.didFailWithError(URLError(.resourceUnavailable))
            return
        }
        let method = task.request.httpMethod?.uppercased() ?? "GET"
        guard method == "GET" || method == "HEAD" else {
            send(task, url, status: 405, type: "text/plain; charset=utf-8", policy: policies.shell, body: Data("Method not allowed".utf8))
            return
        }
        let name: String, policy: String
        switch ShellRoute.route(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? "") {
        case .page:
            (name, policy) = ("index.html", policies.shell)
        case .render:
            (name, policy) = ("render.html", policies.render)
        case .file(let path, let orPage):
            (name, policy) = (file(path, in: folder) != nil || !orPage ? path : "index.html", policies.shell)
        case .missing:
            (name, policy) = ("", policies.shell)
        }
        guard !name.isEmpty, let file = file(name, in: folder), let body = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            send(task, url, status: 404, type: "text/plain; charset=utf-8", policy: policies.shell, body: Data("Not found".utf8))
            return
        }
        send(task, url, status: 200, type: ShellRoute.contentType(name), policy: policy, body: method == "HEAD" ? Data() : body, length: body.count)
    }

    /// The file `name` names within the shell's folder, or nil: a regular file there and nowhere else.
    private static func file(_ name: String, in folder: URL) -> URL? {
        let file = folder.appendingPathComponent(name).resolvingSymlinksInPath()
        var isFolder: ObjCBool = false
        guard file.path.hasPrefix(folder.path + "/"), FileManager.default.fileExists(atPath: file.path, isDirectory: &isFolder), !isFolder.boolValue else { return nil }
        return file
    }

    private static func send(_ task: WKURLSchemeTask, _ url: URL, status: Int, type: String, policy: String, body: Data, length: Int? = nil) {
        let headers = [
            "Content-Type": type,
            "Content-Length": String(length ?? body.count),
            // as Capacitor answers its own files: the files are the app's, read again at each load
            "Cache-Control": "no-cache",
            "Content-Security-Policy": policy
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }
}

extension WebViewAssetHandler {
    /// Capacitor's `webView(_:start:)` once ShellHost.origin has put this in its place; the call to itself below is
    /// then Capacitor's own.
    @objc fileprivate func ovisWebView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let host = task.request.url?.host?.lowercased()
        if host == Home.bundledHost {
            ovisWebView(webView, start: task)
        } else if let shell = ShellHost.origin?.host, host == shell {
            ShellHost.answer(task)
        } else {
            task.didFailWithError(URLError(.unsupportedURL))
        }
    }
}

/// Shown once after the update to a build with the shell inside the app, to a phone that had signed in or paired a
/// PC on the hosted origin (PCStore.setAsideHosted): the shell's pages are on another origin now, so that sign-in and
/// those pairings are out of its reach. It says so, and that signing in again brings the account's PCs back; its one
/// button opens the shell's own first screen, where the sign-in is.
final class ShellMovedViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = HerdrBridgeViewController.pageColor
        let words = Home.movedNotice(languages: Locale.preferredLanguages, kept: !PCStore.saved.isEmpty)

        let title = UILabel()
        title.text = words.title
        title.font = .preferredFont(forTextStyle: .title2)
        title.textColor = HerdrBridgeViewController.strongColor
        let body = UILabel()
        body.text = words.body
        body.font = .preferredFont(forTextStyle: .body)
        body.textColor = HerdrBridgeViewController.textColor
        for label in [title, body] {
            label.adjustsFontForContentSizeCategory = true
            label.numberOfLines = 0
            label.textAlignment = .natural
        }
        var look = UIButton.Configuration.filled()
        look.title = words.button
        look.baseBackgroundColor = HerdrBridgeViewController.accentColor
        look.baseForegroundColor = .white
        look.buttonSize = .large
        let button = UIButton(configuration: look, primaryAction: UIAction { _ in
            PCStore.moveNotice = false
            // the shell's first screen, where the sign-in is, over a PC that is still current
            PCStore.homeAttempt("#pcs")
            HerdrBridgeViewController.reopen()
        })
        button.accessibilityIdentifier = "shell-moved-continue"

        let stack = UIStackView(arrangedSubviews: [title, body, button])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 16
        stack.setCustomSpacing(24, after: body)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = false
        scroll.addSubview(stack)
        view.addSubview(scroll)
        let content = scroll.contentLayoutGuide, frame = scroll.frameLayoutGuide
        let fill = content.heightAnchor.constraint(equalTo: frame.heightAnchor)
        fill.priority = .defaultLow
        // the width of a phone's screen, and no wider than a column reads well on an iPad
        let wide = stack.widthAnchor.constraint(equalTo: frame.widthAnchor, constant: -48)
        wide.priority = .defaultHigh
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            content.widthAnchor.constraint(equalTo: frame.widthAnchor),
            content.heightAnchor.constraint(greaterThanOrEqualTo: frame.heightAnchor),
            fill,
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
            stack.widthAnchor.constraint(lessThanOrEqualTo: frame.widthAnchor, constant: -48),
            wide
        ])
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
    }
}
