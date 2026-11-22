import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// Stage a Universal Link before constructing the first bridge (or replacing a warm one).
    private func takeLink(_ activity: NSUserActivity) -> Bool {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "app.ovis.sh", parts.port == nil,
              parts.user == nil, parts.password == nil else { return false }
        let path = parts.percentEncodedPath
        if path == "/t/" {
            guard url.absoluteString.hasPrefix("https://app.ovis.sh/t/#"), url.absoluteString.utf8.count <= 300 else { return false }
        } else {
            guard path.range(of: #"^/s/[0-9a-f]{32}/?$"#, options: .regularExpression) != nil else { return false }
            let fragment = parts.percentEncodedFragment ?? ""
            if parts.query != nil || !(fragment.isEmpty || fragment.hasPrefix("offer=") || fragment.hasPrefix("sign-in=")) {
                let key = "https://app.ovis.sh" + path + (path.hasSuffix("/") ? "" : "/")
                guard PCStore.saved.contains(key) else { return false }
                PCStore.current = key
                PCStore.last = key
                PCStore.choosing = false
                PCStore.pendingStart = url.absoluteString
                PCStore.link = nil
                PCStore.failure = nil
                PCStore.redirects = 0
                return true
            }
        }
        PCStore.link = url.absoluteString
        PCStore.choosing = true
        return true
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let tookLink = connectionOptions.userActivities.contains(where: takeLink)
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = HerdrBridgeViewController.first()
        window?.makeKeyAndVisible()

        if !tookLink { SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions) }
    }

    /// Back in front: each SSH PC listens again where iOS took its socket, and a connection that no longer answers is
    /// made again before the page asks (OvisSsh); nothing typed is sent again.
    func sceneWillEnterForeground(_ scene: UIScene) {
        // a port another app took meanwhile leaves the web view's rule: the web view is built again without it
        OvisSsh.tunnels.wakeAll(lost: { DispatchQueue.main.async { HerdrBridgeViewController.reopen() } })
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if takeLink(userActivity) { HerdrBridgeViewController.reopen() }
        else { SceneDelegateProxy.shared.scene(scene, continue: userActivity) }
    }
}
