import Foundation
import XCTest
@testable import OvisActivityUI

final class ActivityInboxStateTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000)
    private func request(server: String = "a", revision: String = "1", options: [String] = ["one", "two"],
                         multiple: Bool = true, expiresAt: Date? = nil) -> InboxRequest {
        InboxRequest(id: .init(serverID: server, sessionID: "session", requestID: "same"),
                     revision: revision, sessionTitle: server, prompt: "Choose", detail: "",
                     kind: .interview(options: options.map { .init(id: $0, title: $0) },
                                      allowsMultiple: multiple, allowsCustomInput: true), expiresAt: expiresAt)
    }
    private func snapshot(_ state: inout ActivityInboxState, _ requests: [InboxRequest], connected: Bool = true) {
        state.reconcile(connection: connected ? .connected : .disconnected, sessions: [], completions: [], requests: requests, now: now)
    }

    func testSelectionsUseFullRequestIdentityAndArrivalDoesNotStealFocus() throws {
        let a = request(), b = request(server: "b")
        var state = ActivityInboxState()
        snapshot(&state, [a])
        state.toggle("one", in: a, now: now)
        snapshot(&state, [b, a])
        XCTAssertEqual(state.currentKey, a.id)
        XCTAssertEqual(state.selectedOptions(for: a.id), ["one"])
        XCTAssertEqual(state.selectedOptions(for: b.id), [])
        state.toggle("two", in: b, now: now)
        XCTAssertEqual(state.selectedOptions(for: a.id), ["one"])
        XCTAssertEqual(state.selectedOptions(for: b.id), ["two"])
        let command = try XCTUnwrap(state.beginSubmission(.choices(["two"]), for: b, now: now))
        XCTAssertEqual(command.target, b.id)
        XCTAssertEqual(state.presentation(for: a.id), .ready)
        XCTAssertEqual(state.presentation(for: b.id), .pending)
    }

    func testRevisionAndContentChangesInvalidateDraftAndOldActions() {
        let original = request(), revised = request(revision: "2")
        var state = ActivityInboxState()
        snapshot(&state, [original])
        state.toggle("one", in: original, now: now)
        snapshot(&state, [revised])
        XCTAssertEqual(state.selectedOptions(for: revised.id), [])
        state.toggle("one", in: original, now: now)
        XCTAssertNil(state.beginSubmission(.choices(["one"]), for: original, now: now))
        state.toggle("two", in: revised, now: now)
        let changed = request(revision: "2", options: ["one"])
        snapshot(&state, [changed])
        XCTAssertEqual(state.selectedOptions(for: changed.id), [])
        XCTAssertFalse(state.canSubmitChoices(changed, now: now))
    }

    func testOptionRemovalInvalidatesDraftEvenWithoutRevisionChange() {
        let original = request(), changed = request(options: ["two"])
        var state = ActivityInboxState()
        snapshot(&state, [original])
        state.toggle("one", in: original, now: now)
        state.toggle("two", in: original, now: now)
        snapshot(&state, [changed])
        XCTAssertEqual(state.selectedOptions(for: changed.id), [])
        XCTAssertNil(state.beginSubmission(.choices(["one", "two"]), for: changed, now: now))
    }

    func testLateAcknowledgementCannotResolveNewRevisionOrNewAttempt() throws {
        let old = request(), new = request(revision: "2")
        var state = ActivityInboxState()
        snapshot(&state, [old])
        state.toggle("one", in: old, now: now)
        let first = try XCTUnwrap(state.beginSubmission(.choices(["one"]), for: old, now: now))
        snapshot(&state, [new])
        state.toggle("two", in: new, now: now)
        let second = try XCTUnwrap(state.beginSubmission(.choices(["two"]), for: new, now: now))
        state.resolve(token: first.token, target: first.target, revision: first.revision, error: nil)
        XCTAssertEqual(state.presentation(for: new.id), .pending)
        XCTAssertEqual(state.currentRequest, new)
        state.resolve(token: second.token, target: second.target, revision: second.revision, error: "Failed")
        let retry = try XCTUnwrap(state.beginSubmission(.choices(["two"]), for: new, now: now))
        state.resolve(token: second.token, target: second.target, revision: second.revision, error: nil)
        XCTAssertEqual(state.presentation(for: new.id), .pending)
        state.resolve(token: retry.token, target: retry.target, revision: retry.revision, error: nil)
        XCTAssertNil(state.currentRequest)
    }

    func testDuplicateSubmitOfflineRefusalAndFailureRetry() throws {
        let item = request(multiple: false)
        var state = ActivityInboxState()
        snapshot(&state, [item], connected: false)
        state.toggle("one", in: item, now: now)
        XCTAssertNil(state.beginSubmission(.choices(["one"]), for: item, now: now))
        XCTAssertEqual(state.presentation(for: item.id), .disconnected)
        state.reconcile(connection: .stale, sessions: [], completions: [], requests: [item], now: now)
        XCTAssertEqual(state.presentation(for: item.id), .stale)
        XCTAssertNil(state.beginSubmission(.choices(["one"]), for: item, now: now))
        snapshot(&state, [item])
        let first = try XCTUnwrap(state.beginSubmission(.choices(["one"]), for: item, now: now))
        XCTAssertNil(state.beginSubmission(.choices(["one"]), for: item, now: now))
        state.resolve(token: first.token, target: first.target, revision: first.revision, error: "Try again")
        XCTAssertEqual(state.presentation(for: item.id), .error("Try again"))
        XCTAssertEqual(state.selectedOptions(for: item.id), ["one"])
        let retry = try XCTUnwrap(state.beginSubmission(.choices(["one"]), for: item, now: now))
        XCTAssertNotEqual(first.token, retry.token)
        XCTAssertEqual(state.presentation(for: item.id), .pending)
    }

    func testSuccessRequiresMatchingServerAcknowledgementAndDoesNotReappear() throws {
        let item = request(), other = request(server: "b")
        var state = ActivityInboxState()
        snapshot(&state, [item, other])
        state.toggle("one", in: item, now: now)
        let command = try XCTUnwrap(state.beginSubmission(.choices(["one"]), for: item, now: now))
        XCTAssertEqual(state.requests.count, 2)
        state.resolve(token: command.token, target: other.id, revision: command.revision, error: nil)
        XCTAssertEqual(state.requests.count, 2)
        state.resolve(token: command.token, target: command.target, revision: command.revision, error: nil)
        XCTAssertEqual(state.requests, [other])
        snapshot(&state, [item, other])
        XCTAssertEqual(state.requests, [other])
        let revised = request(revision: "2")
        snapshot(&state, [revised, other])
        XCTAssertEqual(state.requests, [revised, other])
    }

    func testExpiryRemovalAndAmbiguousKeysRejectActions() {
        let item = request(expiresAt: now.addingTimeInterval(1))
        var state = ActivityInboxState()
        snapshot(&state, [item])
        state.toggle("one", in: item, now: now)
        XCTAssertNil(state.beginSubmission(.choices(["one"]), for: item, now: now.addingTimeInterval(1)))
        state.reconcile(connection: .connected, sessions: [], completions: [], requests: [item], now: now.addingTimeInterval(1))
        XCTAssertNil(state.currentRequest)
        XCTAssertEqual(state.selectedOptions(for: item.id), [])
        snapshot(&state, [item, item])
        XCTAssertTrue(state.requests.isEmpty)
    }

    func testExpiredAcknowledgementAndChangedContentCannotResolveReplacement() throws {
        let item = request(expiresAt: now.addingTimeInterval(1))
        var state = ActivityInboxState()
        snapshot(&state, [item])
        state.toggle("one", in: item, now: now)
        let expired = try XCTUnwrap(state.beginSubmission(.choices(["one"]), for: item, now: now))
        state.resolve(token: expired.token, target: expired.target, revision: expired.revision,
                      error: nil, now: now.addingTimeInterval(1))
        XCTAssertTrue(state.requests.isEmpty)

        let original = request(), changed = request(options: ["two"])
        snapshot(&state, [original])
        state.toggle("one", in: original, now: now)
        let stale = try XCTUnwrap(state.beginSubmission(.choices(["one"]), for: original, now: now))
        snapshot(&state, [changed])
        state.toggle("two", in: changed, now: now)
        let current = try XCTUnwrap(state.beginSubmission(.choices(["two"]), for: changed, now: now))
        state.resolve(token: stale.token, target: stale.target, revision: stale.revision, error: nil, now: now)
        XCTAssertEqual(state.presentation(for: changed.id), .pending)
        state.resolve(token: current.token, target: current.target, revision: current.revision, error: nil, now: now)
        XCTAssertTrue(state.requests.isEmpty)
    }

    func testSingleChoiceReplacesSelection() {
        let item = request(multiple: false)
        var state = ActivityInboxState()
        snapshot(&state, [item])
        state.toggle("one", in: item, now: now)
        state.toggle("two", in: item, now: now)
        XCTAssertEqual(state.selectedOptions(for: item.id), ["two"])
        XCTAssertNotNil(state.beginSubmission(.choices(["two"]), for: item, now: now))
    }

    func testCompletionDestinationAndRunningCount() {
        let a = SessionReference(serverID: "a", sessionID: "same")
        let b = SessionReference(serverID: "b", sessionID: "same")
        let completion = Completion(id: .init(session: b, completionID: "done"), title: "Done", subtitle: "B")
        var state = ActivityInboxState()
        state.reconcile(connection: .connected, sessions: [.init(session: a, status: .running),
            .init(session: b, status: .waiting), .init(session: a, status: .idle),
            .init(session: b, status: .finished)], completions: [completion], requests: [], now: now)
        XCTAssertEqual(state.runningCount, 0)
        XCTAssertEqual(state.completions.first?.destination, b)
        XCTAssertNotEqual(state.completions.first?.destination, a)
    }

    func testDuplicateSessionsAreDeduplicatedAndConflictsExcluded() {
        let a = SessionReference(serverID: "a", sessionID: "same")
        let b = SessionReference(serverID: "b", sessionID: "same")
        let c = SessionReference(serverID: "c", sessionID: "same")
        var state = ActivityInboxState()
        let runningA = SessionActivity(session: a, status: .running)
        let runningB = SessionActivity(session: b, status: .running)
        let conflict = SessionActivity(session: b, status: .waiting)
        let idleC = SessionActivity(session: c, status: .idle)
        for activities in [[runningA, runningA, runningB, conflict, idleC],
                           [idleC, conflict, runningB, runningA, runningA]] {
            state.reconcile(connection: .connected, sessions: activities, completions: [], requests: [], now: now)
            XCTAssertEqual(state.runningCount, 1)
            XCTAssertEqual(Set(state.sessions.map(\.session)), Set([a, c]))
        }
    }

    func testDuplicateCompletionsDedupeExactAndRejectConflicts() {
        let session = SessionReference(serverID: "a", sessionID: "session")
        let first = Completion(id: .init(session: session, completionID: "one"), title: "One", subtitle: "Done")
        let second = Completion(id: .init(session: session, completionID: "two"), title: "Two", subtitle: "Done")
        let conflict = Completion(id: second.id, title: "Changed", subtitle: "Done")
        var state = ActivityInboxState()
        for items in [[first, first, second, conflict], [conflict, second, first, first]] {
            state.reconcile(connection: .connected, sessions: [], completions: items, requests: [], now: now)
            XCTAssertEqual(state.completions, [first])
        }
    }

    func testNavigationReferencesRequireCurrentRevisionConnectionAndNoPendingSubmission() throws {
        let original = request(), revised = request(revision: "2"), other = request(server: "b")
        var state = ActivityInboxState()
        snapshot(&state, [original, other])
        let reference = RequestReference(key: original.id, revision: original.revision)
        XCTAssertEqual(reference, original.reference)
        XCTAssertTrue(state.isCurrent(reference, now: now))
        XCTAssertTrue(state.canAct(on: reference, now: now))
        state.focus(other, now: now)
        XCTAssertFalse(state.canAct(on: reference, now: now))
        state.focus(original, now: now)
        state.toggle("one", in: original, now: now)
        let command = try XCTUnwrap(state.beginSubmission(.choices(["one"]), for: original, now: now))
        XCTAssertFalse(state.canAct(on: reference, now: now))
        state.resolve(token: command.token, target: command.target, revision: command.revision, error: "Failed", now: now)
        XCTAssertTrue(state.canAct(on: reference, now: now))
        state.reconcile(connection: .stale, sessions: [], completions: [], requests: [original], now: now)
        XCTAssertFalse(state.canAct(on: reference, now: now))
        snapshot(&state, [original], connected: false)
        XCTAssertFalse(state.canAct(on: reference, now: now))
        snapshot(&state, [revised])
        XCTAssertFalse(state.isCurrent(reference, now: now))
        XCTAssertFalse(state.canAct(on: reference, now: now))
        XCTAssertTrue(state.canAct(on: revised.reference, now: now))
    }

    func testCompletionModeSurvivesIncomingRequestsAndPreservesDraft() {
        let first = request(), other = request(server: "b")
        var state = ActivityInboxState()
        snapshot(&state, [first])
        state.toggle("one", in: first, now: now)
        state.showCompletions()
        snapshot(&state, [other, first])
        XCTAssertEqual(state.mode, .completions)
        XCTAssertFalse(state.canAct(on: first.reference, now: now))
        XCTAssertEqual(state.currentKey, first.id)
        XCTAssertEqual(state.selectedOptions(for: first.id), ["one"])
        state.showRequests()
        XCTAssertEqual(state.mode, .requests)
        XCTAssertTrue(state.canAct(on: first.reference, now: now))
        XCTAssertEqual(state.selectedOptions(for: first.id), ["one"])
        state.showCompletions()
        state.focus(other, now: now)
        XCTAssertEqual(state.mode, .requests)
        XCTAssertEqual(state.selectedOptions(for: first.id), ["one"])
    }

    func testErrorAcknowledgementAfterExpiryCannotRestoreActions() throws {
        let item = request(expiresAt: now.addingTimeInterval(1))
        var state = ActivityInboxState()
        snapshot(&state, [item])
        state.toggle("one", in: item, now: now)
        let command = try XCTUnwrap(state.beginSubmission(.choices(["one"]), for: item, now: now))
        let expired = now.addingTimeInterval(1)
        state.resolve(token: command.token, target: command.target, revision: command.revision, error: "Failed", now: expired)
        XCTAssertNil(state.currentRequest)
        XCTAssertEqual(state.selectedOptions(for: item.id), [])
        XCTAssertFalse(state.canAct(on: item.reference, now: expired))
        XCTAssertNil(state.beginSubmission(.choices(["one"]), for: item, now: expired))
        state.reconcile(connection: .connected, sessions: [], completions: [], requests: [item], now: expired)
        XCTAssertTrue(state.requests.isEmpty)
    }

    func testApprovalOnlyAllowsOneTimeOrDenyAndChoiceValidation() {
        let item = request()
        let approval = InboxRequest(id: item.id, revision: "1", sessionTitle: "A", prompt: "Allow?",
                                    detail: "", kind: .approval(supportsAlwaysSettings: true))
        var state = ActivityInboxState()
        snapshot(&state, [approval])
        XCTAssertNil(state.beginSubmission(.choices(["one"]), for: approval, now: now))
        XCTAssertNotNil(state.beginSubmission(.allowOnce, for: approval, now: now))
        snapshot(&state, [item])
        XCTAssertNil(state.beginSubmission(.choices([]), for: item, now: now))
        state.toggle("one", in: item, now: now)
        XCTAssertNil(state.beginSubmission(.choices(["two"]), for: item, now: now))
        XCTAssertNil(state.beginSubmission(.choices(["one", "one"]), for: item, now: now))
    }
}
