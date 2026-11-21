import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // an SSH PC listens on its address on this phone before its page loads (HerdrBridgeViewController.reopen)
        window?.rootViewController = UIViewController()
        window?.rootViewController?.view.backgroundColor = UIColor(red: 0x12 / 255, green: 0x10 / 255, blue: 0x0e / 255, alpha: 1)
        window?.makeKeyAndVisible()
        HerdrBridgeViewController.reopen()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// Back in front: each SSH PC listens again where iOS took its socket, and a connection that no longer answers is
    /// made again before the page asks (OvisSsh); nothing typed is sent again.
    func sceneWillEnterForeground(_ scene: UIScene) {
        OvisSsh.tunnels.wakeAll()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
