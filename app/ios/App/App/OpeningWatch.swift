import Foundation

/// What HerdrBridgeViewController's cover says while a PC opens, as OpeningWatch.java does on
/// Android. iOS has no count of the bytes the app receives; the web view's estimatedProgress, which
/// grows as the page and its files arrive, stands in for it once the PC has answered. Before that
/// answer nothing is seen, so the open gives up when the answer limit passes. A PC that answered is
/// never called off: while its page keeps coming the cover says the link is slow, and when nothing
/// more comes for `stallSeconds` it offers Keep waiting and Try again. Times are seconds on one clock
/// (ProcessInfo.systemUptime in the app).
struct OpeningWatch {
    enum Stage: Equatable {
        /// Nothing to say yet: "Opening …".
        case opening
        /// The PC answered and the page still has not shown: a slow link.
        case slow
        /// It answered, then the page did not move for `stallSeconds`.
        case stalled
        /// No answer within the limit: the cover says so, with Try again.
        case noAnswer
    }

    /// How long a first page may take before the cover calls the link slow.
    static let slowAfterSeconds: TimeInterval = 5
    /// How long the page may not move, once the PC answered, before the cover says the link stalled.
    static let stallSeconds: TimeInterval = 20
    /// The most the bar shows until the client is up: the page's load also has its script to run.
    static let maxShown = 0.95

    private let startedAt: TimeInterval
    private let answerLimit: TimeInterval
    private(set) var answered = false
    private var lastProgress = 0.0
    private var lastProgressAt: TimeInterval
    private var shown = 0.0

    init(now: TimeInterval, answerLimit: TimeInterval) {
        startedAt = now
        self.answerLimit = answerLimit
        lastProgressAt = now
    }

    /// The PC answered the first page.
    mutating func answer(at now: TimeInterval) {
        answered = true
        lastProgressAt = now
    }

    /// The web view's estimatedProgress is `fraction` at `now`: more than before is the page moving.
    mutating func progress(_ fraction: Double, at now: TimeInterval) {
        guard fraction > lastProgress else { return }
        lastProgress = fraction
        if answered { lastProgressAt = now }
    }

    /// Keep waiting on a stalled open: the stall is counted again from `now`.
    mutating func keepWaiting(at now: TimeInterval) {
        lastProgressAt = now
    }

    /// What the bar shows, 0 to maxShown: never less than before.
    mutating func shownProgress() -> Double {
        shown = max(shown, min(Self.maxShown, lastProgress))
        return shown
    }

    /// Whether `host` (a URL's host, IPv6 in brackets or not) is an address of a home network or a
    /// tailnet, which opens only from inside it, as homeHost in app/web/shell.js decides: only there
    /// do the PC, the home network and its firewall explain no answer.
    static func homeHost(_ host: String) -> Bool {
        let name = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if name == "localhost" || name.hasSuffix(".localhost") || name == "::1" || name.hasSuffix(".ts.net") || name.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4, let last = parts.last, Int(last) != nil {
            let numbers = parts.compactMap { Int($0) }
            guard numbers.count == 4 else { return false }
            let (a, b) = (numbers[0], numbers[1])
            return a == 10 || a == 127 || (a == 100 && (64...127).contains(b)) || (a == 172 && (16...31).contains(b))
                || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        if name.contains(":") { return name.hasPrefix("fc") || name.hasPrefix("fd") || ["fe8", "fe9", "fea", "feb"].contains { name.hasPrefix($0) } }
        return !name.contains(".") || [".local", ".lan", ".home.arpa", ".internal"].contains { name.hasSuffix($0) }
    }

    func stage(at now: TimeInterval) -> Stage {
        let elapsed = now - startedAt
        if !answered { return elapsed >= answerLimit ? .noAnswer : .opening }
        if now - lastProgressAt >= Self.stallSeconds { return .stalled }
        return elapsed >= Self.slowAfterSeconds ? .slow : .opening
    }
}
