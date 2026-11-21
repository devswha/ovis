import Foundation

public struct SessionReference: Hashable {
    public let serverID: String
    public let sessionID: String
    public init(serverID: String, sessionID: String) {
        self.serverID = serverID
        self.sessionID = sessionID
    }
}

public struct RequestKey: Hashable {
    public let serverID: String
    public let sessionID: String
    public let requestID: String
    public var session: SessionReference { .init(serverID: serverID, sessionID: sessionID) }
    public init(serverID: String, sessionID: String, requestID: String) {
        self.serverID = serverID
        self.sessionID = sessionID
        self.requestID = requestID
    }
}

/// Identifies the exact request revision that a host navigation action refers to.
public struct RequestReference: Hashable {
    public let key: RequestKey
    public let revision: String
    public init(key: RequestKey, revision: String) {
        self.key = key
        self.revision = revision
    }
}

public struct CompletionKey: Hashable {
    public let session: SessionReference
    public let completionID: String
    public init(session: SessionReference, completionID: String) {
        self.session = session
        self.completionID = completionID
    }
}

public struct Completion: Identifiable, Equatable {
    public let id: CompletionKey
    public let title: String
    public let subtitle: String
    public var destination: SessionReference { id.session }
    public init(id: CompletionKey, title: String, subtitle: String) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
    }
}

public enum SessionStatus: Equatable { case running, idle, waiting, finished }
public struct SessionActivity: Equatable {
    public let session: SessionReference
    public let status: SessionStatus
    public init(session: SessionReference, status: SessionStatus) {
        self.session = session
        self.status = status
    }
}

public struct ChoiceOption: Identifiable, Equatable {
    public let id: String
    public let title: String
    public init(id: String, title: String) { self.id = id; self.title = title }
}

public enum RequestKind: Equatable {
    case approval(supportsAlwaysSettings: Bool)
    case interview(options: [ChoiceOption], allowsMultiple: Bool, allowsCustomInput: Bool)
}

public struct InboxRequest: Identifiable, Equatable {
    public let id: RequestKey
    public let revision: String
    public let sessionTitle: String
    public let prompt: String
    public let detail: String
    public let kind: RequestKind
    public let expiresAt: Date?
    public var reference: RequestReference { .init(key: id, revision: revision) }
    public init(id: RequestKey, revision: String, sessionTitle: String, prompt: String,
                detail: String, kind: RequestKind, expiresAt: Date? = nil) {
        self.id = id
        self.revision = revision
        self.sessionTitle = sessionTitle
        self.prompt = prompt
        self.detail = detail
        self.kind = kind
        self.expiresAt = expiresAt
    }
    fileprivate func isValid(at now: Date) -> Bool { expiresAt.map { $0 > now } ?? true }
}

public enum SubmissionAnswer: Equatable {
    case allowOnce, deny, choices([String])
}

/// The adapter must return this token and revision with its server result.
public struct SubmissionCommand: Equatable {
    public let token: UUID
    public let target: RequestKey
    public let revision: String
    public let answer: SubmissionAnswer
}

public enum SnapshotConnection: Equatable { case connected, stale, disconnected }

public enum RequestPresentation: Equatable {
    case disconnected, stale, pending, error(String), ready
}

public enum InboxMode: Equatable { case requests, completions }

public struct ActivityInboxState {
    public private(set) var connection: SnapshotConnection = .disconnected
    public private(set) var sessions: [SessionActivity] = []
    public private(set) var completions: [Completion] = []
    public private(set) var requests: [InboxRequest] = []
    public private(set) var currentKey: RequestKey?
    public private(set) var mode: InboxMode = .requests
    private var selections: [RequestKey: Set<String>] = [:]
    private var pending: [RequestKey: SubmissionCommand] = [:]
    private var errors: [RequestKey: String] = [:]
    private var resolved: [RequestKey: String] = [:]

    public init() {}
    public var runningCount: Int { sessions.filter { $0.status == .running }.count }
    public var currentRequest: InboxRequest? { requests.first { $0.id == currentKey } }
    public func selectedOptions(for key: RequestKey) -> Set<String> { selections[key] ?? [] }
    public func isCurrent(_ reference: RequestReference, now: Date = Date()) -> Bool {
        guard mode == .requests, currentKey == reference.key, let request = currentRequest else { return false }
        return request.reference == reference && request.isValid(at: now)
    }
    public func canAct(on reference: RequestReference, now: Date = Date()) -> Bool {
        guard isCurrent(reference, now: now), connection == .connected, pending[reference.key] == nil else { return false }
        return true
    }
    public mutating func showCompletions() { mode = .completions }
    public mutating func showRequests() { mode = .requests }
    public func presentation(for key: RequestKey) -> RequestPresentation {
        if connection == .disconnected { return .disconnected }
        if connection == .stale { return .stale }
        if pending[key] != nil { return .pending }
        if let error = errors[key] { return .error(error) }
        return .ready
    }

    /// A snapshot is authoritative. Duplicate requests and conflicting identities are rejected;
    /// identical session and completion entries are collapsed.
    public mutating func reconcile(connection: SnapshotConnection, sessions: [SessionActivity], completions: [Completion],
                                   requests incoming: [InboxRequest], now: Date = Date()) {
        self.connection = connection
        let sessionsByID = Dictionary(grouping: sessions, by: \.session)
        var seenSessions = Set<SessionReference>()
        self.sessions = sessions.filter { item in
            guard let group = sessionsByID[item.session], group.allSatisfy({ $0 == item }) else { return false }
            return seenSessions.insert(item.session).inserted
        }
        let completionsByID = Dictionary(grouping: completions, by: \.id)
        var seenCompletions = Set<CompletionKey>()
        self.completions = completions.filter { item in
            guard let group = completionsByID[item.id], group.allSatisfy({ $0 == item }) else { return false }
            return seenCompletions.insert(item.id).inserted
        }
        let counts = Dictionary(incoming.map { ($0.id, 1) }, uniquingKeysWith: +)
        let old = Dictionary(uniqueKeysWithValues: requests.map { ($0.id, $0) })
        let next = incoming.filter { request in
            counts[request.id] == 1 && request.isValid(at: now) && resolved[request.id] != request.revision
        }
        let nextByKey = Dictionary(uniqueKeysWithValues: next.map { ($0.id, $0) })
        for (key, request) in old where nextByKey[key] != request {
            selections.removeValue(forKey: key)
            pending.removeValue(forKey: key)
            errors.removeValue(forKey: key)
        }
        for request in incoming where resolved[request.id] != nil && resolved[request.id] != request.revision {
            resolved.removeValue(forKey: request.id)
        }
        requests = next
        if currentKey.flatMap({ nextByKey[$0] }) == nil { currentKey = next.first?.id }
    }

    public mutating func focus(_ request: InboxRequest, now: Date = Date()) {
        guard requests.contains(request), request.isValid(at: now) else { return }
        currentKey = request.id
        mode = .requests
    }

    public mutating func toggle(_ optionID: String, in request: InboxRequest, now: Date = Date()) {
        guard requests.contains(request), request.isValid(at: now), pending[request.id] == nil,
              case let .interview(options, multiple, _) = request.kind,
              options.filter({ $0.id == optionID }).count == 1 else { return }
        currentKey = request.id
        var selected = selections[request.id] ?? []
        if selected.contains(optionID) { selected.remove(optionID) }
        else if multiple { selected.insert(optionID) }
        else { selected = [optionID] }
        selections[request.id] = selected
        errors.removeValue(forKey: request.id)
    }

    public func canSubmitChoices(_ request: InboxRequest, now: Date = Date()) -> Bool {
        guard connection == .connected, requests.contains(request), request.isValid(at: now), pending[request.id] == nil,
              case let .interview(options, multiple, _) = request.kind else { return false }
        let selected = selectedOptions(for: request.id)
        let ids = options.map(\.id)
        return !selected.isEmpty && (multiple || selected.count == 1)
            && Set(ids).count == ids.count && selected.isSubset(of: Set(ids))
    }

    /// Call only for an explicit tap. A command never implies server success.
    public mutating func beginSubmission(_ answer: SubmissionAnswer, for request: InboxRequest,
                                         now: Date = Date()) -> SubmissionCommand? {
        guard connection == .connected, requests.contains(request), request.isValid(at: now), pending[request.id] == nil else { return nil }
        switch (request.kind, answer) {
        case (.approval, .allowOnce), (.approval, .deny): break
        case (.interview, .choices(let choices)):
            guard canSubmitChoices(request, now: now), Set(choices) == selectedOptions(for: request.id),
                  Set(choices).count == choices.count else { return nil }
        default: return nil
        }
        let command = SubmissionCommand(token: UUID(), target: request.id, revision: request.revision, answer: answer)
        pending[request.id] = command
        errors.removeValue(forKey: request.id)
        currentKey = request.id
        return command
    }

    /// Ignore late, duplicated and superseded acknowledgements, including old attempts at the same revision.
    public mutating func resolve(token: UUID, target: RequestKey, revision: String, error: String?, now: Date = Date()) {
        guard let command = pending[target], command.token == token, command.revision == revision,
              let request = requests.first(where: { $0.id == target && $0.revision == revision }) else { return }
        pending.removeValue(forKey: target)
        if !request.isValid(at: now) {
            requests.removeAll { $0.id == target }
            selections.removeValue(forKey: target)
            errors.removeValue(forKey: target)
            if currentKey == target { currentKey = requests.first?.id }
            return
        }
        if let error {
            errors[target] = error
        } else {
            resolved[target] = revision
            requests.removeAll { $0 == request }
            selections.removeValue(forKey: target)
            errors.removeValue(forKey: target)
            if currentKey == target { currentKey = requests.first?.id }
        }
    }
}
