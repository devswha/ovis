import Foundation

/// Which screen the app opens, and what the hosted Connect a PC screen ("home") does while it is up: the decisions
/// alone, so HerdrBridgeViewController only carries them out (HomeTests; Home.java is the Android twin). Home is the
/// hosted app's front page opened as the web view's first page without being the current PC; the app's own bundled
/// page stands in for it when it cannot load.
public enum Home {
    /// What a view controller opens as its first page.
    public enum Screen {
        /// The current PC, at its own address.
        case pc
        /// The hosted Connect a PC screen.
        case home
        /// The app's own Connect a PC page (index.html): the fallback, what only it can take, or a build's first screen.
        case bundled
        /// The bundled demo.
        case demo
    }

    /// Where a view controller that opened home is.
    public enum Phase {
        /// Home has not shown yet: its cover is up.
        case loading
        case shown
        /// Home was given up on: the view controller is on its way out to the bundled page, and nothing moves it again.
        case fallback
        /// A relay PC's page came up in it: the hosted app is the current PC, and the rules of a PC's page decide.
        case pc
    }

    public enum Event: CaseIterable {
        /// Home's page is up (its client drew).
        case loaded
        /// A main-frame load failed, or answered with an HTTP error.
        case failed
        /// Home took too long (timedOut).
        case timedOut
        /// The web view went to a relay PC's page (relayPc).
        case relayPc
    }

    public enum Action {
        case none
        case liftCover
        /// The bundled page instead, marked as the fallback for this process.
        case fallBack
        /// The hosted app becomes the current PC, which ends choosing.
        case keepHosted
    }

    /// Where the way back leads: the page's own back control on iOS, the phone's Back on Android.
    public enum Back {
        /// A step back in the page's own history.
        case page
        /// The PC the screen was opened from to choose another.
        case current
        /// Home again.
        case home
        /// Nowhere (on Android the system's Back, which leaves the app).
        case leave
    }

    /// How long home may take to answer before the bundled page stands in.
    public static let loadSeconds: TimeInterval = 8

    /// How long a page that answered may take to come up, as long as a PC gets to answer.
    public static let answerSeconds: TimeInterval = 20

    /// The screen a view controller starts on. `hosted`: the build's first screen is the hosted one (OVIS_APP_HOME);
    /// `pc`: a PC is to open (none while the person chooses another); `demo`: the demo was asked for (HerdrShell
    /// openDemo); `asked`: something waits that only the bundled page takes (an SSH setup, an SSH PC whose address
    /// another app holds); `failed`: home did not load in this process and was not tried again since.
    public static func screen(hosted: Bool, pc: Bool, demo: Bool, asked: Bool, failed: Bool) -> Screen {
        if asked && !pc { return .bundled }
        if demo { return .demo }
        if pc { return .pc }
        return hosted && !failed ? .home : .bundled
    }

    public static func on(_ phase: Phase, _ event: Event) -> Action {
        if phase == .fallback || phase == .pc { return .none }
        switch event {
        case .loaded: return phase == .loading ? .liftCover : .none
        case .failed: return .fallBack
        case .timedOut: return phase == .loading ? .fallBack : .none
        case .relayPc: return .keepHosted
        }
    }

    public static func after(_ phase: Phase, _ event: Event) -> Phase {
        switch on(phase, event) {
        case .liftCover: return .shown
        case .fallBack: return .fallback
        case .keepHosted: return .pc
        case .none: return phase
        }
    }

    /// Whether home took too long, `elapsed` seconds after it started (time the app spent in front): `loadSeconds`
    /// with no answer, and `answerSeconds` once its page is on its way, which a slow link needs.
    public static func timedOut(elapsed: TimeInterval, answered: Bool) -> Bool {
        elapsed >= (answered ? answerSeconds : loadSeconds)
    }

    /// Where the way back leads on `screen`. `failed` as for `screen`; `choosing`: the screen is up to choose another
    /// PC, with one still current; `pageHasBack`: the page has a step of its own to take first. The bundled page while
    /// choosing goes back to the PC at once, as it always did.
    public static func back(screen: Screen, hosted: Bool, failed: Bool, choosing: Bool, pageHasBack: Bool) -> Back {
        if screen == .bundled && choosing { return .current }
        if pageHasBack { return .page }
        switch screen {
        case .home: return choosing ? .current : .leave
        case .demo: return .home
        // home handed over to this page (an SSH setup): the fallback never goes back by itself
        case .bundled: return hosted && !failed ? .home : .leave
        case .pc: return .leave
        }
    }

    /// Whether `url` is a page of a relay PC on the hosted app at `appOrigin`: within `/s/<server_id>/`, as a browser
    /// loads it (no `.` or `..` segment, plain or percent-encoded, no encoded `/` and no `\`).
    public static func relayPc(_ url: URL?, appOrigin: URL?) -> Bool {
        guard let url, let appOrigin, url.scheme?.lowercased() == "https", appOrigin.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), host == appOrigin.host?.lowercased(), (url.port ?? 443) == (appOrigin.port ?? 443),
              let path = URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedPath else { return false }
        let lower = path.lowercased()
        if path.contains("\\") || lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") || lower.contains("%25") { return false }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        // "", "s", the PC's id, then anything within it
        guard segments.count >= 3, segments[0].isEmpty, segments[1] == "s", !segments.contains(where: { $0 == "." || $0 == ".." }) else { return false }
        let id = segments[2]
        return id.utf8.count == 32 && id.utf8.allSatisfy { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }
    }

    /// Whether `text` is what the word "demo" becomes in the hosted screen's address field (`https://demo/`): the
    /// bundled demo, as that word opens it on the bundled page. No PC answers there: a one-word name has no certificate.
    public static func demoAddress(_ text: String?) -> Bool {
        guard let text, let parts = URLComponents(string: text) else { return false }
        return parts.scheme?.lowercased() == "https" && parts.host?.lowercased() == "demo" && parts.port == nil
            && (parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/") && parts.query == nil && parts.fragment == nil
            && parts.user == nil && parts.password == nil
    }
}
