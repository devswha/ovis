import AppKit
import WebKit

/// The main window's title bar, folded away while the window shows the Ovis page: the page's header
/// takes its place (`Resources/title-bar.js`), as the Codex and Claude apps draw their own. An empty
/// compact toolbar gives the bar its height and centres the traffic lights on it; the page is handed
/// that height and the lights' right edge, so its header matches the bar and starts clear of them.
/// The setup, and a window the page opened, keep a title bar of their own.
@MainActor
enum TitleBar {
    private static let source = Bundle.main.url(forResource: "title-bar", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    /// Folds the window's bar away and returns the page's script for it; nil leaves the bar as it was
    /// (a build without the script, or a bar AppKit did not lay out as expected).
    static func fold(_ window: NSWindow) -> String? {
        guard let source else { return nil }
        window.styleMask.insert(.fullSizeContentView)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        addToolbar(window)
        window.layoutIfNeeded()
        guard let zoom = window.standardWindowButton(.zoomButton), let bar = zoom.superview?.superview else {
            unfold(window)
            return nil
        }
        let post = "(ask) => window.webkit?.messageHandlers?.ovisTitleBar?.postMessage(ask)"
        return "(() => {\n\(source)\novisTitleBar(document, \(bar.frame.height), \(zoom.frame.maxX), \(post));\n})();"
    }

    /// Has AppKit look again for the views under the bar that take its clicks. It looks as the bar turns
    /// transparent, finding the page; but as the window comes on screen (its first showing at a restored
    /// frame, after Hide or the Dock) it asks only SwiftUI's view around the page, which takes none, and
    /// the bar then takes every click on the header.
    static func refresh(_ window: NSWindow) {
        window.titlebarAppearsTransparent = false
        window.titlebarAppearsTransparent = true
    }

    /// The window's own bar back, for the setup that takes the page's place.
    static func unfold(_ window: NSWindow) {
        window.toolbar = nil
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        window.styleMask.remove(.fullSizeContentView)
    }

    /// In full screen the bar is a window of its own over the page, and a toolbar keeps it there: it goes
    /// for full screen, so the bar hides with the menu bar, and comes back after.
    static func addToolbar(_ window: NSWindow) {
        window.toolbar = NSToolbar()
        window.toolbarStyle = .unifiedCompact
    }

    /// A double click on a title bar does what System Settings › Desktop & Dock says.
    static func doubleClick(_ window: NSWindow) {
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default: window.performZoom(nil)
        }
    }
}

/// The page's asks from its header (`title-bar.js`), taken only from the main window's page and its own
/// frame: a window the page opened, and a web panel's frame of any site, can post them too.
final class TitleBarMessages: NSObject, WKScriptMessageHandler {
    private weak var webView: OvisWebView?

    init(_ webView: OvisWebView) {
        self.webView = webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let webView, message.webView === webView, message.frameInfo.isMainFrame, let window = webView.window else { return }
            switch message.body as? String {
            case "drag": webView.armDrag()
            case "zoom": TitleBar.doubleClick(window)
            default: break
            }
        }
    }
}
