#if canImport(SwiftUI)
import SwiftUI

/// Use these separately in compact leading and trailing regions; the system owns the space between them.
public struct ActivityCompactLeading: View {
    private let logo: Image
    public init(logo: Image) { self.logo = logo }
    public var body: some View {
        logo.resizable().scaledToFit().frame(width: 24, height: 24).accessibilityLabel("Ovis")
    }
}

public struct ActivityCompactTrailing: View {
    private let runningCount: Int
    public init(runningCount: Int) { self.runningCount = runningCount }
    public var body: some View {
        Label("\(runningCount)", systemImage: "waveform")
            .font(.caption.weight(.semibold)).foregroundStyle(.mint)
            .accessibilityLabel("실행 중인 세션 \(runningCount)개")
    }
}

/// UI-only callbacks, not WidgetKit integration. The host owns navigation, transport and
/// acknowledgements, and must revalidate a request reference before acting on it later.
public struct ActivityInboxActions {
    public var submit: (SubmissionCommand) -> Void
    public var openSession: (SessionReference) -> Void
    public var openAllCompletions: () -> Void
    public var openAllRequests: () -> Void
    public var openAlwaysSettings: (RequestReference) -> Void
    public var openCustomInput: (RequestReference) -> Void
    public init(submit: @escaping (SubmissionCommand) -> Void,
                openSession: @escaping (SessionReference) -> Void,
                openAllCompletions: @escaping () -> Void,
                openAllRequests: @escaping () -> Void,
                openAlwaysSettings: @escaping (RequestReference) -> Void,
                openCustomInput: @escaping (RequestReference) -> Void) {
        self.submit = submit
        self.openSession = openSession
        self.openAllCompletions = openAllCompletions
        self.openAllRequests = openAllRequests
        self.openAlwaysSettings = openAlwaysSettings
        self.openCustomInput = openCustomInput
    }
}

/// An isolated SwiftUI component; it does not itself provide a WidgetKit activity.
public struct ActivityInboxView: View {
    @Binding private var state: ActivityInboxState
    private let logo: Image
    private let actions: ActivityInboxActions
    public init(state: Binding<ActivityInboxState>, logo: Image, actions: ActivityInboxActions) {
        self._state = state
        self.logo = logo
        self.actions = actions
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                ActivityCompactLeading(logo: logo)
                Spacer(minLength: 30)
                ActivityCompactTrailing(runningCount: state.runningCount)
            }
            if state.connection != .connected {
                Label(state.connection == .stale ? "정보가 오래되어 요청을 보낼 수 없습니다" : "연결이 끊겨 요청을 보낼 수 없습니다", systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let request = state.currentRequest, state.mode == .requests {
                Button("완료 알림 보기") { state.showCompletions() }.font(.caption)
                requestView(request)
                if state.requests.count > 1 {
                    HStack {
                        ForEach(Array(([request] + state.requests.filter { $0.id != request.id }).prefix(2))) { item in
                            Button(item.sessionTitle) { state.focus(item) }
                                .buttonStyle(.bordered)
                                .tint(item.id == request.id ? .mint : .gray)
                                .accessibilityLabel("\(item.sessionTitle) 요청 보기")
                        }
                    }
                    .font(.caption)
                    if state.requests.count > 2 {
                        Button("요청 전체 보기 (\(state.requests.count)개)", action: actions.openAllRequests)
                            .font(.caption)
                    }
                }
            } else {
                if state.currentRequest != nil {
                    Button("요청으로 돌아가기") { state.showRequests() }.font(.caption)
                }
                completionView
            }
        }
        .padding(16)
        .foregroundStyle(.white)
        .background(.black, in: RoundedRectangle(cornerRadius: 28))
    }

    private var completionView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("완료 \(state.completions.count)개").font(.headline)
            if state.completions.isEmpty {
                Text("완료 알림이 없습니다").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(Array(state.completions.prefix(2))) { completion in
                Button {
                    actions.openSession(completion.destination)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "doc.text").foregroundStyle(.mint)
                        VStack(alignment: .leading) {
                            Text(completion.title).font(.subheadline.weight(.semibold))
                            Text(completion.subtitle).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(completion.title), \(completion.subtitle) 열기")
            }
            if state.completions.count > 2 {
                Button("완료 알림 전체 보기 (\(state.completions.count)개)", action: actions.openAllCompletions)
                    .font(.subheadline.weight(.medium)).frame(maxWidth: .infinity)
                    .buttonStyle(.bordered).tint(.blue)
            }
        }
    }

    @ViewBuilder private func requestView(_ request: InboxRequest) -> some View {
        VStack(spacing: 8) {
            Text(request.sessionTitle).font(.caption).foregroundStyle(.secondary)
            Text(request.prompt).font(.headline).multilineTextAlignment(.center)
            if !request.detail.isEmpty {
                Text(request.detail).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            switch request.kind {
            case .approval(let supportsAlwaysSettings):
                HStack {
                    Button("이번만 허용") { submit(.allowOnce, request) }
                        .buttonStyle(.borderedProminent).tint(.orange).foregroundStyle(.black)
                    Button("거절") { submit(.deny, request) }.buttonStyle(.bordered)
                }
                .disabled(!canAct(request))
                if supportsAlwaysSettings {
                    Button("항상 허용 설정 ↗") {
                        guard canAct(request) else { return }
                        actions.openAlwaysSettings(request.reference)
                    }
                    .font(.caption).foregroundStyle(.blue)
                    .disabled(!canAct(request))
                }
            case let .interview(options, multiple, allowsCustomInput):
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    let selected = state.selectedOptions(for: request.id).contains(option.id)
                    Button {
                        state.toggle(option.id, in: request)
                    } label: {
                        HStack {
                            Image(systemName: selected ? (multiple ? "checkmark.square.fill" : "largecircle.fill.circle") : (multiple ? "square" : "circle"))
                            Text(option.title)
                            Spacer()
                        }.contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .disabled(!canAct(request))
                    .accessibilityLabel(option.title)
                    .accessibilityValue(selected ? "선택됨" : "선택되지 않음")
                }
                HStack {
                    Button("선택 항목 보내기") {
                        let selected = state.selectedOptions(for: request.id)
                        submit(.choices(options.map(\.id).filter { selected.contains($0) }), request)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!state.canSubmitChoices(request))
                    if allowsCustomInput {
                        Button("앱에서 직접 입력 ↗") {
                            guard canAct(request) else { return }
                            actions.openCustomInput(request.reference)
                        }
                        .font(.caption).foregroundStyle(.blue)
                        .disabled(!canAct(request))
                    }
                }
            }
            switch state.presentation(for: request.id) {
            case .pending: Label("보내는 중", systemImage: "hourglass").font(.caption)
            case .error(let message): Label(message, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            case .disconnected, .stale, .ready: EmptyView()
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func isCurrent(_ request: InboxRequest) -> Bool {
        state.requests.contains(request) && state.isCurrent(request.reference)
    }
    private func canAct(_ request: InboxRequest) -> Bool {
        isCurrent(request) && state.canAct(on: request.reference)
    }
    private func submit(_ answer: SubmissionAnswer, _ request: InboxRequest) {
        if let command = state.beginSubmission(answer, for: request) { actions.submit(command) }
    }
}
#endif
