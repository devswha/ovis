import Foundation
import OvisPushCore
import UserNotifications

/// Shows a PC's push. The relay's mutable-content alert carries the PC's ciphertext in "ovis"
/// (RFC 8291, aes128gcm), opened here with the phone's keys from the keychain group shared with the
/// app; the relay never holds a key that could read it. One alert per pane tag, as public/sw.js and
/// the Android app show them. A push that cannot be opened still shows, with the relay's fallback
/// line.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNNotificationContent?

    private struct Payload: Decodable {
        let title: String?
        let body: String?
        let tag: String?
        // what a tap opens (OvisPushPlugin didReceive): the pane, and the PC that sent it
        let pane_id: String?
        let machine_id: String?
        let workspace_id: String?
        let endpoint: String?
        let server_id: String?
    }

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        content.title = "Ovis"
        content.body = Locale.preferredLanguages.first?.hasPrefix("ko") == true
            ? "herdr가 확인을 기다리고 있습니다" : "herdr needs you"
        content.threadIdentifier = "herdr"
        lock.lock()
        handler = contentHandler
        bestAttempt = content.copy() as? UNNotificationContent
        lock.unlock()
        if let sealed = request.content.userInfo["ovis"] as? String,
           let message = Data(base64Encoded: sealed),
           let group = Bundle.main.object(forInfoDictionaryKey: "OvisPushKeychainGroup") as? String {
            do {
                if let keys = try PushKeyStore(accessGroup: group).read() {
                    let plain = try WebPushDecrypt.decrypt(message, keys: keys)
                    let payload = try JSONDecoder().decode(Payload.self, from: plain)
                    content.title = payload.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Ovis"
                    content.body = payload.body ?? ""
                    content.threadIdentifier = payload.tag.flatMap { $0.isEmpty ? nil : $0 } ?? "herdr"
                    // kept with the notification for its tap; the ciphertext stays as it came
                    var tap: [String: String] = [:]
                    tap["pane_id"] = payload.pane_id
                    tap["machine_id"] = payload.machine_id
                    tap["workspace_id"] = payload.workspace_id
                    tap["endpoint"] = payload.endpoint
                    tap["server_id"] = payload.server_id
                    if !tap.isEmpty { content.userInfo["ovis_tap"] = tap }
                }
            } catch {
                // A missing key, damaged push or old subscription still gets a visible alert.
            }
        }
        lock.lock()
        bestAttempt = content.copy() as? UNNotificationContent
        lock.unlock()
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { [self] delivered in
            let ids = delivered.filter {
                $0.request.content.threadIdentifier == content.threadIdentifier
            }.map { $0.request.identifier }
            center.removeDeliveredNotifications(withIdentifiers: ids)
            finish()
        }
    }

    override func serviceExtensionTimeWillExpire() { finish() }

    /// Expiration and the delivered-notification lookup may finish together; deliver only once.
    private func finish() {
        lock.lock()
        let callback = handler
        let content = bestAttempt
        handler = nil
        lock.unlock()
        if let content = content { callback?(content) }
    }
}
