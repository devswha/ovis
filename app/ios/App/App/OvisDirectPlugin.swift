import Capacitor
import Foundation
import WebKit

/// The PC's direct carriers for the hosted shell (src/lib/relay/directSocket.ts; docs/relay.md, "Direct on
/// the same network"): a page on https cannot open plain `ws://`. Only the main frame of the app's own
/// origin (DirectCallGate) may call it, only `ws://<private IPv4>:<port>/v1/ws?v=1` opens, at most two at
/// once. Frames go to the page in order as `{ id, kind, data }` (binary as base64); a socket whose messages
/// the page has not acknowledged pass 4 MiB or 16,384 is closed with 1009. Noise inside the channel proves
/// the PC: the address is only a hint. Android's twin: app/android/app/src/main/java/sh/ovis/app/OvisDirectPlugin.java.
@objc(OvisDirectPlugin)
public class OvisDirectPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OvisDirectPlugin"
    public let jsName = "OvisDirect"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise)
    ]

    static let maxSockets = 2
    static let maxQueuedBytes = 4 * 1024 * 1024
    static let maxQueuedMessages = 16_384

    private final class Socket {
        let task: URLSessionWebSocketTask
        /// sizes of the messages sent to the page and not acknowledged yet, oldest first
        var unacked: [Int] = []
        var unackedBytes = 0
        /// sends handed to the task and not completed yet: bounded as the page's queue is
        var pendingSends = 0
        var pendingBytes = 0
        var finished = false
        init(task: URLSessionWebSocketTask) { self.task = task }
    }

    /// every socket's state, and the session's callbacks, on this one queue
    private let queue = DispatchQueue(label: "sh.ovis.direct")
    private var sockets: [String: Socket] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        // the relay channel keeps itself alive and the page gives up on a carrier that does not answer
        configuration.timeoutIntervalForRequest = 24 * 3600
        let delegates = OperationQueue()
        delegates.underlyingQueue = queue
        delegates.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: SessionEvents(plugin: self), delegateQueue: delegates)
    }()

    /// `text` when it is exactly a direct carrier's channel address: a private IPv4 address in plain
    /// dotted form (10/8, 172.16/12, 192.168/16, 169.254/16), a port, `/v1/ws?v=1`.
    static func carrierURL(_ text: String) -> URL? {
        let parts = text.split(separator: "/", omittingEmptySubsequences: false)
        guard text.hasPrefix("ws://"), text.hasSuffix("/v1/ws?v=1"), parts.count == 5 else { return nil }
        let hostPort = parts[2].split(separator: ":", omittingEmptySubsequences: false)
        guard hostPort.count == 2, let port = Int(hostPort[1]), (1...65535).contains(port), String(port) == hostPort[1] else { return nil }
        let octets = hostPort[0].split(separator: ".", omittingEmptySubsequences: false)
        let numbers = octets.compactMap { part -> Int? in
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ ("0"..."9").contains($0) }), part == "0" || part.first != "0" else { return nil }
            return Int(part).flatMap { $0 <= 255 ? $0 : nil }
        }
        guard octets.count == 4, numbers.count == 4 else { return nil }
        let a = numbers[0], b = numbers[1]
        guard a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 169 && b == 254) else { return nil }
        return URL(string: text)
    }

    /// Only a call DirectCallGate let through: from the main frame of the app's own origin.
    private func allowed(_ call: CAPPluginCall) -> Bool {
        guard DirectCallGate.take(call.callbackId) else {
            call.reject("OvisDirect answers only the app's own page", "not_allowed")
            return false
        }
        return true
    }

    @objc func open(_ call: CAPPluginCall) {
        guard allowed(call) else { return }
        guard let text = call.getString("url"), let url = Self.carrierURL(text) else {
            call.reject("Only a direct carrier on a private address opens", "invalid_url")
            return
        }
        queue.async {
            guard self.sockets.count < Self.maxSockets else {
                call.reject("Two direct sockets are open already", "too_many")
                return
            }
            let task = self.session.webSocketTask(with: url)
            task.maximumMessageSize = Self.maxQueuedBytes
            let id = UUID().uuidString
            self.sockets[id] = Socket(task: task)
            // answered before the socket starts, so the page knows it before any of its events
            call.resolve(["id": id])
            task.resume()
            self.receive(id)
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard allowed(call) else { return }
        guard let id = call.getString("id"), let kind = call.getString("kind"), let data = call.getString("data") else {
            call.reject("Send an id, a kind and data", "invalid_frame")
            return
        }
        let message: URLSessionWebSocketTask.Message
        switch kind {
        case "text": message = .string(data)
        case "binary":
            guard let bytes = Data(base64Encoded: data) else { call.reject("Binary data is base64", "invalid_frame"); return }
            message = .data(bytes)
        default:
            call.reject("A frame is text or binary", "invalid_frame")
            return
        }
        let size: Int
        switch message {
        case .string(let text): size = text.utf8.count
        case .data(let bytes): size = bytes.count
        @unknown default: size = 0
        }
        queue.async {
            guard let socket = self.sockets[id], !socket.finished else { call.reject("That socket is closed", "closed"); return }
            if socket.pendingSends + 1 > Self.maxQueuedMessages || socket.pendingBytes + size > Self.maxQueuedBytes {
                call.resolve()
                socket.task.cancel(with: .messageTooBig, reason: nil)
                self.finish(id, code: 1009, reason: "send queue full", error: false)
                return
            }
            socket.pendingSends += 1
            socket.pendingBytes += size
            // a failed send ends the socket, which its receive reports; completions come on this queue
            socket.task.send(message) { _ in
                socket.pendingSends -= 1
                socket.pendingBytes -= size
            }
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard allowed(call) else { return }
        guard let id = call.getString("id") else { call.reject("Send an id", "invalid_frame"); return }
        let code = call.getInt("code") ?? 1000
        let reason = call.getString("reason") ?? ""
        queue.async {
            guard let socket = self.sockets[id], !socket.finished else { call.resolve(); return }
            socket.task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: reason.data(using: .utf8))
            call.resolve()
            // the PC's answer to the close usually comes first; a peer that never answers ends it here
            self.queue.asyncAfter(deadline: .now() + 5) { self.finish(id, code: code, reason: reason, error: false) }
        }
    }

    @objc func ack(_ call: CAPPluginCall) {
        guard allowed(call) else { return }
        guard let id = call.getString("id"), let messages = call.getInt("messages"), messages > 0 else {
            call.reject("Send an id and a count", "invalid_frame")
            return
        }
        queue.async {
            if let socket = self.sockets[id] {
                let taken = min(messages, socket.unacked.count)
                socket.unackedBytes -= socket.unacked.prefix(taken).reduce(0, +)
                socket.unacked.removeFirst(taken)
            }
            call.resolve()
        }
    }

    private func receive(_ id: String) {
        guard let socket = sockets[id], !socket.finished else { return }
        socket.task.receive { [weak self] result in
            guard let self, let socket = self.sockets[id], !socket.finished else { return }
            switch result {
            case .success(let message):
                let event: [String: Any]
                let size: Int
                switch message {
                case .string(let text):
                    size = text.utf8.count
                    event = ["id": id, "kind": "text", "data": text]
                case .data(let bytes):
                    size = bytes.count
                    event = ["id": id, "kind": "binary", "data": bytes.base64EncodedString()]
                @unknown default:
                    self.finish(id, code: 1003, reason: "unknown frame", error: true)
                    return
                }
                if socket.unacked.count + 1 > Self.maxQueuedMessages || socket.unackedBytes + size > Self.maxQueuedBytes {
                    socket.task.cancel(with: .messageTooBig, reason: nil)
                    self.finish(id, code: 1009, reason: "receive queue full", error: false)
                    return
                }
                socket.unacked.append(size)
                socket.unackedBytes += size
                self.emit("message", event)
                self.receive(id)
            case .failure:
                let code = socket.task.closeCode
                if code != .invalid {
                    self.finish(id, code: code.rawValue, reason: socket.task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? "", error: false)
                } else {
                    self.finish(id, code: 1006, reason: "", error: true)
                }
            }
        }
    }

    /// Ends `id` once: an error event first when it broke, then its close event.
    fileprivate func finish(_ id: String, code: Int, reason: String, error: Bool) {
        guard let socket = sockets[id], !socket.finished else { return }
        socket.finished = true
        sockets[id] = nil
        socket.task.cancel()
        if error { emit("error", ["id": id]) }
        emit("close", ["id": id, "code": code, "reason": reason])
    }

    /// To the page on the bridge's queue, where Capacitor adds and removes listeners; one serial queue, so a
    /// socket's events keep their order.
    private func emit(_ event: String, _ data: [String: Any]) {
        let target = (bridge as? CapacitorBridge)?.dispatchQueue ?? DispatchQueue.main
        target.async { self.notifyListeners(event, data: data) }
    }

    fileprivate func finish(task: URLSessionTask, code: Int, reason: String, error: Bool) {
        guard let id = sockets.first(where: { $0.value.task === task })?.key else { return }
        finish(id, code: code, reason: reason, error: error)
    }

    /// A new page in the web view: the old page's sockets would hold both places and nobody reads them.
    public override func load() {
        NotificationCenter.default.addObserver(forName: .ovisPageCommitted, object: nil, queue: nil) { [weak self] _ in
            DirectCallGate.clear()
            guard let self else { return }
            self.queue.async {
                for id in Array(self.sockets.keys) { self.finish(id, code: 1001, reason: "page left", error: false) }
            }
        }
    }
}

extension Notification.Name {
    /// The web view's main frame committed a new page (NavigationFailureProxy).
    static let ovisPageCommitted = Notification.Name("sh.ovis.pageCommitted")
}

/// The session's callbacks, on the plugin's queue; held weakly, as the session holds its delegate.
private final class SessionEvents: NSObject, URLSessionWebSocketDelegate {
    weak var plugin: OvisDirectPlugin?
    init(plugin: OvisDirectPlugin) { self.plugin = plugin }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        plugin?.finish(task: webSocketTask, code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "", error: false)
    }

    /// A carrier is the address the page named and nothing else: a redirect of the upgrade fails it.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        plugin?.finish(task: task, code: 1006, reason: "", error: error != nil)
    }
}

/// Stands in front of Capacitor's script message handler: an OvisDirect call goes on only from the main
/// frame of the app's own origin (the hosted shell, https://app.ovis.sh), never from a PC page opened by
/// its address or any frame, which Capacitor's iOS bridge would otherwise let call every plugin. The
/// plugin acts only on calls this let through, so without the gate it answers nothing.
final class DirectCallGate: NSObject, WKScriptMessageHandler {
    static let appHost = "app.ovis.sh"
    private static let lock = NSLock()
    private static var approved = Set<String>()
    private let inner: WKScriptMessageHandler

    private init(inner: WKScriptMessageHandler) { self.inner = inner }

    /// Puts the gate in front of Capacitor's "bridge" handler; before the first page loads.
    static func install(on handler: WebViewDelegationHandler) {
        handler.contentController.removeScriptMessageHandler(forName: "bridge")
        handler.contentController.add(DirectCallGate(inner: handler), name: "bridge")
    }

    /// The calls the gate guards; Capacitor's own listener methods go on as they are, as events reach only the main frame.
    static let guarded: Set<String> = ["open", "send", "close", "ack"]

    /// A new page: approvals left by the old one are dropped.
    static func clear() {
        lock.lock()
        approved.removeAll()
        lock.unlock()
    }

    static func take(_ callbackId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return approved.remove(callbackId) != nil
    }

    static func fromApp(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        return frame.isMainFrame && origin.protocol == "https" && origin.host.lowercased() == appHost && (origin.port == 0 || origin.port == 443)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any], body["pluginId"] as? String == "OvisDirect",
           let method = body["methodName"] as? String, Self.guarded.contains(method) {
            guard Self.fromApp(message.frameInfo), let callbackId = body["callbackId"] as? String else { return }
            Self.lock.lock()
            Self.approved.insert(callbackId)
            Self.lock.unlock()
        }
        inner.userContentController(controller, didReceive: message)
    }
}
