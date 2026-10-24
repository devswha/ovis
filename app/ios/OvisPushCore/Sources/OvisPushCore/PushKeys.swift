import CryptoKit
import Foundation
import Security

/// One phone's keys serve every PC; only the relay endpoint is PC-specific.
public struct PushKeys {
    public let privateKey: P256.KeyAgreement.PrivateKey
    public let auth: Data
    public var publicPoint: Data { privateKey.publicKey.x963Representation }

    public init(privateKey: P256.KeyAgreement.PrivateKey, auth: Data) {
        self.privateKey = privateKey
        self.auth = auth
    }

    public static func generate() throws -> PushKeys {
        var auth = Data(count: 16)
        let status = auth.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!)
        }
        guard status == errSecSuccess else { throw PushKeyStore.Failure.keychain(status) }
        return PushKeys(privateKey: P256.KeyAgreement.PrivateKey(), auth: auth)
    }
}

/// The extension can read after first unlock, but only the app creates keys.
public struct PushKeyStore {
    public enum Failure: Error {
        case keychain(OSStatus)
        case damaged
    }

    private let accessGroup: String

    public init(accessGroup: String) { self.accessGroup = accessGroup }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "sh.ovis.app.push",
            kSecAttrAccount as String: "keys",
            kSecAttrAccessGroup as String: accessGroup
        ]
    }

    public func read() throws -> PushKeys? {
        var query = query
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        guard let data = result as? Data else { throw Failure.damaged }
        return try Self.decode(data)
    }

    static func decode(_ data: Data) throws -> PushKeys {
        guard data.count == 48 else { throw Failure.damaged }
        do {
            return PushKeys(
                privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: data.prefix(32)),
                auth: Data(data.suffix(16))
            )
        } catch { throw Failure.damaged }
    }

    /// Only the app calls this; read() in the extension never repairs or rotates keys.
    public func getOrCreate() throws -> PushKeys {
        try Self.getOrCreate(read: read, remove: remove, create: create)
    }

    static func getOrCreate(read: () throws -> PushKeys?, remove: () throws -> Void,
                            create: () throws -> PushKeys) throws -> PushKeys {
        do {
            if let keys = try read() { return keys }
        } catch Failure.damaged {
            try remove()
        }
        return try create()
    }

    private func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.keychain(status) }
    }

    private func create() throws -> PushKeys {
        let keys = try PushKeys.generate()
        var query = query
        query[kSecValueData as String] = keys.privateKey.rawRepresentation + keys.auth
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem, let existing = try read() { return existing }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        return keys
    }
}
