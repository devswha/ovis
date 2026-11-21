import Foundation

/// The phone's SshTunnels, one per saved SSH PC, and what they share, as Android's SshTunnels.java: the dialer that
/// signs in with the PC's saved key and host key, and the listener that hands a failure to the app.
public final class SshTunnels: @unchecked Sendable {
    public typealias FailureListener = @Sendable (SshPcs.Pc, SshFailure) -> Void

    private let store: SshPcs
    private let lock = NSLock()
    private var tunnels: [String: (pc: SshPcs.Pc, tunnel: SshTunnel)] = [:]
    public var listener: FailureListener?

    public init(store: SshPcs) { self.store = store }

    /// The ports the saved SSH PCs listen on.
    public func ports() -> Set<Int> { Set(store.list().map(\.localPort)) }

    /// The tunnel for `pc`, listening: kept while the PC's saved way in stays the same. Throws when another app holds
    /// the address: the PC must not open then, as the page that answers there would be that app's.
    @discardableResult
    public func open(_ pc: SshPcs.Pc) async throws -> SshTunnel {
        guard let gate = store.gate(pc) else { throw SshFailure("key-unreadable", "This phone can no longer open the gate saved for this PC") }
        let store = self.store
        // the entry is in place before anything waits, so a second open for the same PC finds it and shares its bind
        let tunnel: SshTunnel = lock.locked {
            if let entry = tunnels[pc.origin] {
                if Self.same(entry.pc, pc) { return entry.tunnel }
                Task { await entry.tunnel.close() }
            }
            let made = SshTunnel(gate: gate, port: pc.localPort, dialer: { try await Self.dial(store, pc) },
                                 sshPorts: { [weak self] in self?.ports() ?? [] },
                                 listener: { [weak self] failure in self?.listener?(pc, failure) })
            tunnels[pc.origin] = (pc, made)
            return made
        }
        do {
            try await tunnel.listen()
        } catch {
            lock.locked { if tunnels[pc.origin]?.tunnel === tunnel { tunnels[pc.origin] = nil } }
            throw error
        }
        return tunnel
    }

    private static func same(_ a: SshPcs.Pc, _ b: SshPcs.Pc) -> Bool {
        a.hostKey == b.hostKey && a.hostKeyAlgorithm == b.hostKeyAlgorithm && a.auth == b.auth && a.importedKey == b.importedKey
            && a.host == b.host && a.port == b.port && a.user == b.user && a.gate == b.gate
    }

    /// Connects to `pc` with what was saved when it was added: its host key, and its key. Never asks anything.
    public static func dial(_ store: SshPcs, _ pc: SshPcs.Pc) async throws -> SshTunnelLink {
        guard pc.hasHostKey else { throw SshFailure("host-key-unknown", "The host key is not confirmed") }
        let check = SshConnection.HostKeyCheck(expectedAlgorithm: pc.hostKeyAlgorithm, expectedKey: pc.hostKey)
        let connection: SshConnection
        if pc.auth == "tailscale" {
            // nobody is on the setup screen to open a check link: the error page shows it, and Try again signs in again
            connection = try await SshConnection.openTailscale(host: pc.host, port: pc.port, check: check, user: pc.user, waitSeconds: SshConnection.signInSeconds) { banner in
                SshConnection.checkLink(banner).map { SshFailure("tailscale-check", "Tailscale SSH asks to approve this phone again", command: $0) }
            }
        } else {
            connection = try await SshConnection.open(host: pc.host, port: pc.port, check: check, user: pc.user, key: try store.signInKey(pc))
        }
        do {
            return SshConnectionLink(connection, port: try await SshLink.ovisPort(connection))
        } catch {
            connection.close()
            throw SshFailure.from(error)
        }
    }

    /// What the PC `pc` knows of other PCs, from its own Ovis over its tunnel: the hosts of its ssh config and its
    /// Tailscale login's PCs (`/api/machines/ssh-candidates`), and the PCs it has added (`/api/machines`), each JSON as
    /// it answers. A PC whose Ovis is older, or refuses, gives what it gave; neither list is required.
    public func known(_ pc: SshPcs.Pc) async throws -> (candidates: Data?, machines: Data?) {
        let tunnel = try await open(pc)
        var failure: Error?
        var answers: [Data?] = []
        for path in ["/api/machines/ssh-candidates", "/api/machines"] {
            do { answers.append(try await tunnel.get(path)) } catch {
                failure = failure ?? error
                answers.append(nil)
            }
        }
        if answers.allSatisfy({ $0 == nil }), let failure { throw SshFailure.from(failure) }
        return (answers[0], answers[1])
    }

    public func closeFor(_ origin: String) {
        let entry = lock.locked { tunnels.removeValue(forKey: origin) }
        if let entry { Task { await entry.tunnel.close() } }
    }

    private func all() -> [SshTunnel] { lock.locked { tunnels.values.map(\.tunnel) } }

    /// The app came back: each tunnel listens again where iOS took its socket, and checks its connection.
    public func wakeAll() {
        for tunnel in all() {
            Task {
                try? await tunnel.listen()
                await tunnel.wake()
            }
        }
    }

    /// The phone's network changed: every SSH connection is dropped, and the next request makes a new one.
    public func dropAll() {
        for tunnel in all() { Task { await tunnel.drop() } }
    }
}

extension NSLock {
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
