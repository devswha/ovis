#if canImport(SwiftUI)
import SwiftUI

private enum PreviewData {
    static let session = SessionReference(serverID: "server-a", sessionID: "session-a")
    static let approval = InboxRequest(
        id: .init(serverID: "server-a", sessionID: "session-a", requestID: "approval"),
        revision: "1", sessionTitle: "API 업데이트 · Claude", prompt: "테스트 실행을 허용할까요?",
        detail: "이 프로젝트 · 이 요청", kind: .approval(supportsAlwaysSettings: true))
    static let interview = InboxRequest(
        id: .init(serverID: "server-a", sessionID: "session-a", requestID: "interview"),
        revision: "1", sessionTitle: "웹 업데이트 · Codex", prompt: "테스트 범위를 선택하세요",
        detail: "", kind: .interview(options: [.init(id: "quick", title: "빠른 테스트"),
                                                .init(id: "full", title: "전체 테스트")],
                                    allowsMultiple: false, allowsCustomInput: true))
    static func state(requests: [InboxRequest] = [], connected: Bool = true,
                      completions: [Completion] = []) -> ActivityInboxState {
        var state = ActivityInboxState()
        state.reconcile(connection: connected ? .connected : .disconnected, sessions: [.init(session: session, status: .running)],
                        completions: completions, requests: requests)
        return state
    }
    static var completions: [Completion] {
        (1...3).map { .init(id: .init(session: session, completionID: "\($0)"),
                            title: "완료된 작업 \($0)", subtitle: "Codex · 완료") }
    }
    static var error: ActivityInboxState {
        var state = Self.state(requests: [approval])
        if let command = state.beginSubmission(.deny, for: approval) {
            state.resolve(token: command.token, target: command.target, revision: command.revision, error: "보내지 못했습니다. 다시 시도하세요.")
        }
        return state
    }
}

private struct InboxPreview: View {
    @State var state: ActivityInboxState
    @State private var pendingCommand: SubmissionCommand?
    init(state: ActivityInboxState) { self._state = State(initialValue: state) }
    var body: some View {
        VStack {
            ActivityInboxView(state: $state, logo: Image(systemName: "circle.fill"),
                actions: ActivityInboxActions(submit: { pendingCommand = $0 }, openSession: { _ in },
                    openAllCompletions: {}, openAllRequests: {}, openAlwaysSettings: { _ in }, openCustomInput: { _ in }))
            if let command = pendingCommand {
                Button("데모 응답 확인") {
                    state.resolve(token: command.token, target: command.target, revision: command.revision, error: nil)
                    pendingCommand = nil
                }
            }
        }.padding().background(.gray.opacity(0.3))
    }
}

#Preview("Compact regions") {
    HStack {
        ActivityCompactLeading(logo: Image(systemName: "circle.fill"))
        Spacer(minLength: 120)
        ActivityCompactTrailing(runningCount: 4)
    }.padding().background(.black, in: Capsule()).padding()
}
#Preview("Completions") { InboxPreview(state: PreviewData.state(completions: PreviewData.completions)) }
#Preview("Empty") { InboxPreview(state: PreviewData.state()) }
#Preview("Approval") { InboxPreview(state: PreviewData.state(requests: [PreviewData.approval])) }
#Preview("Interview") { InboxPreview(state: PreviewData.state(requests: [PreviewData.interview])) }
#Preview("Disconnected") { InboxPreview(state: PreviewData.state(requests: [PreviewData.approval], connected: false)) }
#Preview("Error") { InboxPreview(state: PreviewData.error) }
#endif
