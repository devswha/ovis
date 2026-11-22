import XCTest
@testable import OvisHomeCore

final class HomeTests: XCTestCase {
    private let hosted = true, bundledBuild = false

    func testASavedPcOpensDirectlyWhateverElseHolds() {
        XCTAssertEqual(Home.screen(hosted: hosted, pc: true, demo: false, asked: false, failed: false), .pc)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: true, demo: false, asked: false, failed: true), .pc)
        // an SSH PC's failure left over from an earlier open is no reason to keep another PC from opening
        XCTAssertEqual(Home.screen(hosted: hosted, pc: true, demo: false, asked: true, failed: false), .pc)
        XCTAssertEqual(Home.screen(hosted: bundledBuild, pc: true, demo: false, asked: false, failed: false), .pc)
    }

    func testWithNoPcToOpenTheHostedScreenIsHome() {
        // first launch, after Forget or disconnect, and choosing another PC (the caller passes no PC while choosing)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: false, asked: false, failed: false), .home)
    }

    func testTheBundledPageStandsInOnceHomeFailedUntilItIsTriedAgain() {
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: false, asked: false, failed: true), .bundled)
    }

    func testTheBundledPageTakesWhatOnlyItCanTake() {
        // an SSH setup a page asked for, an SSH PC it has to say could not open
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: false, asked: true, failed: false), .bundled)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: false, asked: true, failed: true), .bundled)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: true, asked: true, failed: false), .bundled)
    }

    func testTheDemoAskedForOpensOverAnythingElse() {
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: true, asked: false, failed: false), .demo)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: true, demo: true, asked: false, failed: false), .demo)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: true, asked: false, failed: true), .demo)
        XCTAssertEqual(Home.screen(hosted: bundledBuild, pc: false, demo: true, asked: false, failed: false), .demo)
    }

    func testABuildWithTheBundledFirstScreenNeverOpensHome() {
        for asked in [false, true] {
            for failed in [false, true] {
                XCTAssertEqual(Home.screen(hosted: bundledBuild, pc: false, demo: false, asked: asked, failed: failed), .bundled)
            }
        }
    }

    func testHomeThatLoadsLiftsItsCoverOnce() {
        XCTAssertEqual(Home.on(.loading, .loaded), .liftCover)
        XCTAssertEqual(Home.after(.loading, .loaded), .shown)
        XCTAssertEqual(Home.on(.shown, .loaded), .none)
        XCTAssertEqual(Home.after(.shown, .loaded), .shown)
    }

    func testHomeThatFailsOrTakesTooLongGivesWayToTheBundledPage() {
        XCTAssertEqual(Home.on(.loading, .failed), .fallBack)
        XCTAssertEqual(Home.on(.loading, .timedOut), .fallBack)
        XCTAssertEqual(Home.after(.loading, .failed), .fallback)
        XCTAssertEqual(Home.after(.loading, .timedOut), .fallback)
    }

    func testAPageOfHomeThatFailsLaterGivesWayTooButTheClockNoLongerCounts() {
        // a PC's row pressed with the network gone: the page left behind is no screen to stay on
        XCTAssertEqual(Home.on(.shown, .failed), .fallBack)
        XCTAssertEqual(Home.after(.shown, .failed), .fallback)
        XCTAssertEqual(Home.on(.shown, .timedOut), .none)
        XCTAssertEqual(Home.after(.shown, .timedOut), .shown)
    }

    func testNothingThatComesAfterTheFallbackMovesThePersonAgain() {
        // a load that still finishes, fails once more or runs into the clock: the bundled page is up, with what was typed
        for event in Home.Event.allCases {
            XCTAssertEqual(Home.on(.fallback, event), .none, "\(event)")
            XCTAssertEqual(Home.after(.fallback, event), .fallback, "\(event)")
        }
    }

    func testArrivingAtARelayPcMakesTheHostedAppThePc() {
        for phase in [Home.Phase.loading, .shown] {
            XCTAssertEqual(Home.on(phase, .relayPc), .keepHosted, "\(phase)")
            XCTAssertEqual(Home.after(phase, .relayPc), .pc, "\(phase)")
        }
    }

    func testOnceARelayPcIsUpThePcsOwnRulesDecide() {
        for event in Home.Event.allCases {
            XCTAssertEqual(Home.on(.pc, event), .none, "\(event)")
            XCTAssertEqual(Home.after(.pc, event), .pc, "\(event)")
        }
    }

    func testTheClockRunsOutAtEightSecondsWithNoAnswer() {
        XCTAssertFalse(Home.timedOut(elapsed: 7.999, answered: false))
        XCTAssertTrue(Home.timedOut(elapsed: 8, answered: false))
    }

    func testAPageThatAnsweredGetsAsLongAsAPcDoesToAnswer() {
        // the hosted page is on its way over a slow link: cut off at eight seconds, its script would never finish arriving
        XCTAssertFalse(Home.timedOut(elapsed: 8, answered: true))
        XCTAssertFalse(Home.timedOut(elapsed: Home.answerSeconds - 0.001, answered: true))
        XCTAssertTrue(Home.timedOut(elapsed: Home.answerSeconds, answered: true))
        XCTAssertEqual(Home.answerSeconds, 20)
    }

    func testBackGoesThroughThePagesOwnHistoryFirstAtHome() {
        XCTAssertEqual(Home.back(screen: .home, hosted: hosted, failed: false, choosing: true, pageHasBack: true), .page)
        XCTAssertEqual(Home.back(screen: .home, hosted: hosted, failed: false, choosing: false, pageHasBack: true), .page)
        XCTAssertEqual(Home.back(screen: .pc, hosted: hosted, failed: false, choosing: false, pageHasBack: true), .page)
        XCTAssertEqual(Home.back(screen: .demo, hosted: hosted, failed: false, choosing: false, pageHasBack: true), .page)
    }

    func testBackAtHomeWithNothingBehindReturnsToThePcItWasOpenedFrom() {
        XCTAssertEqual(Home.back(screen: .home, hosted: hosted, failed: false, choosing: true, pageHasBack: false), .current)
        // no PC to go back to: nowhere (on Android the system's Back, which leaves the app)
        XCTAssertEqual(Home.back(screen: .home, hosted: hosted, failed: false, choosing: false, pageHasBack: false), .leave)
    }

    func testBackOnTheBundledPageWhileChoosingReturnsToThePcAtOnceAsBefore() {
        for build in [hosted, bundledBuild] {
            for failed in [false, true] {
                for pageHasBack in [false, true] {
                    XCTAssertEqual(Home.back(screen: .bundled, hosted: build, failed: failed, choosing: true, pageHasBack: pageHasBack), .current)
                }
            }
        }
    }

    func testBackOnTheFallbackLeadsNowhereRatherThanTryHomeAgain() {
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: true, choosing: false, pageHasBack: false), .leave)
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: true, choosing: false, pageHasBack: true), .page)
    }

    func testBackOnTheBundledPageHomeHandedOverToReturnsHome() {
        // the SSH setup took the person off home: this is the way back to it
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: false, choosing: false, pageHasBack: false), .home)
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: false, choosing: false, pageHasBack: true), .page)
    }

    func testBackOnTheBundledFirstScreenLeadsNowhereAsBefore() {
        XCTAssertEqual(Home.back(screen: .bundled, hosted: bundledBuild, failed: false, choosing: false, pageHasBack: false), .leave)
        XCTAssertEqual(Home.back(screen: .bundled, hosted: bundledBuild, failed: false, choosing: false, pageHasBack: true), .page)
    }

    func testBackFromTheDemoReturnsToWhereItWasOpenedFrom() {
        XCTAssertEqual(Home.back(screen: .demo, hosted: hosted, failed: false, choosing: false, pageHasBack: false), .home)
        XCTAssertEqual(Home.back(screen: .demo, hosted: hosted, failed: false, choosing: true, pageHasBack: false), .home)
        XCTAssertEqual(Home.back(screen: .demo, hosted: bundledBuild, failed: false, choosing: false, pageHasBack: false), .home)
    }

    func testBackOnAPcWithNothingBehindLeadsNowhere() {
        XCTAssertEqual(Home.back(screen: .pc, hosted: hosted, failed: false, choosing: false, pageHasBack: false), .leave)
        XCTAssertEqual(Home.back(screen: .pc, hosted: hosted, failed: false, choosing: true, pageHasBack: false), .leave)
    }

    private let app = URL(string: "https://app.ovis.sh")!
    private let id = "0123456789abcdef0123456789abcdef"

    func testARelayPcsPageIsAnyPageWithinAScopeOfTheHostedApp() {
        for page in [
            "https://app.ovis.sh/s/\(id)/",
            "https://app.ovis.sh/s/\(id)",
            "https://app.ovis.sh/s/\(id)/#offer=eyJ2IjoxfQ",
            "https://app.ovis.sh/s/\(id)/?pane=w1%3Ap1",
            "https://app.ovis.sh/s/\(id)/index.html",
            "https://APP.ovis.sh:443/s/\(id)/"
        ] {
            XCTAssertTrue(Home.relayPc(URL(string: page), appOrigin: app), page)
        }
    }

    func testTheHostedAppsOwnPagesAndOtherOriginsAreNoRelayPc() {
        for page in [
            "https://app.ovis.sh/",
            "https://app.ovis.sh/#pcs",
            "https://app.ovis.sh/#add",
            "https://app.ovis.sh/s/",
            "https://app.ovis.sh/s/not-a-pc/",
            "https://app.ovis.sh/s/\(id)0/",
            "https://app.ovis.sh/sx/\(id)/",
            "https://app.ovis.sh/x/s/\(id)/",
            "https://app.ovis.sh/s/\(id)/../\(id)/",
            "https://app.ovis.sh/s/\(id)/%2e%2e/x",
            "https://app.ovis.sh/s/\(id.uppercased())/",
            "http://app.ovis.sh/s/\(id)/",
            "https://app.ovis.sh:8443/s/\(id)/",
            "https://app.ovis.sh.evil.example/s/\(id)/",
            "capacitor://localhost/s/\(id)/",
            "about:blank"
        ] {
            XCTAssertFalse(Home.relayPc(URL(string: page), appOrigin: app), page)
        }
        XCTAssertFalse(Home.relayPc(nil, appOrigin: app))
        XCTAssertFalse(Home.relayPc(URL(string: "https://app.ovis.sh/s/\(id)/"), appOrigin: nil))
        // a build for another hosted origin takes that origin and not the store's
        let preview = URL(string: "https://relay-0510.ovis-app.pages.dev")!
        XCTAssertTrue(Home.relayPc(URL(string: "https://relay-0510.ovis-app.pages.dev/s/\(id)/"), appOrigin: preview))
        XCTAssertFalse(Home.relayPc(URL(string: "https://app.ovis.sh/s/\(id)/"), appOrigin: preview))
    }

    func testTheAddressDemoTypedIntoTheHostedScreenIsTheBundledDemo() {
        // the hosted screen reads a bare word as an https name: what "demo" becomes there, and nothing else
        for typed in ["https://demo", "https://demo/", "https://DEMO/"] {
            XCTAssertTrue(Home.demoAddress(typed), typed)
        }
        for other in [
            "http://demo/", "https://demo:7317/", "https://demo/x", "https://demo/?pair=123456", "https://demo/#offer=x",
            "https://demo.example.com/", "https://my-demo/", "https://demo.ts.net/", "demo", "", "https://"
        ] {
            XCTAssertFalse(Home.demoAddress(other), other)
        }
        XCTAssertFalse(Home.demoAddress(nil))
    }
}
