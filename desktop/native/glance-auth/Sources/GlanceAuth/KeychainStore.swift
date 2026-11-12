import Foundation
import Security
import CryptoKit

struct EnrolledFaceProfile: Codable, Sendable {
    let modelIdentifier: String
    let createdAt: String
    let template: [Float]
    let samples: [[Float]]
}

enum KeychainStoreError: LocalizedError {
    case keychainFailure(OSStatus)
    case invalidData

    var errorDescription: String? {
        switch self {
        case .keychainFailure(let status):
            return "macOS Keychain error (OSStatus \(status))"
        case .invalidData:
            return "Stored credential or face profile data is corrupted."
        }
    }
}

enum KeychainStore {
    private static let service = "com.robustpwd.desktop.glance"
    private static let masterAccount = "master-password"
    private static let faceKeyAccount = "face-encryption-key"

    static var faceFileURL: URL {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".robust-pwd", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("glance-faces.enc")
    }

    static var hasEnrolledFace: Bool {
        FileManager.default.fileExists(atPath: faceFileURL.path)
    }

    static var hasStoredMaster: Bool {
        (try? readKeychainData(account: masterAccount)) != nil
    }

    static func saveMasterPassword(_ master: String) throws {
        guard let data = master.data(using: .utf8) else {
            throw KeychainStoreError.invalidData
        }
        try upsertKeychainData(data, account: masterAccount)
    }

    static func loadMasterPassword() throws -> String? {
        guard let data = try readKeychainData(account: masterAccount) else {
            return nil
        }
        guard let str = String(data: data, encoding: .utf8) else {
            throw KeychainStoreError.invalidData
        }
        return str
    }

    static func saveFaceProfile(_ profile: EnrolledFaceProfile) throws {
        let key = try loadOrCreateFaceKey()
        let plaintext = try JSONEncoder().encode(profile)
        let sealed = try AES.GCM.seal(plaintext, using: key)
        guard let combined = sealed.combined else {
            throw KeychainStoreError.invalidData
        }
        try combined.write(to: faceFileURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: faceFileURL.path)
    }

    static func loadFaceProfile() throws -> EnrolledFaceProfile? {
        guard hasEnrolledFace else { return nil }
        guard let keyData = try readKeychainData(account: faceKeyAccount) else {
            throw KeychainStoreError.invalidData
        }
        let key = SymmetricKey(data: keyData)
        let combined = try Data(contentsOf: faceFileURL)
        let box = try AES.GCM.SealedBox(combined: combined)
        let plaintext = try AES.GCM.open(box, using: key)
        return try JSONDecoder().decode(EnrolledFaceProfile.self, from: plaintext)
    }

    static func clearAll() {
        try? FileManager.default.removeItem(at: faceFileURL)
        deleteKeychainItem(account: masterAccount)
        deleteKeychainItem(account: faceKeyAccount)
    }

    // MARK: - Keychain Helpers

    private static func loadOrCreateFaceKey() throws -> SymmetricKey {
        if let existing = try readKeychainData(account: faceKeyAccount), existing.count == 32 {
            return SymmetricKey(data: existing)
        }
        let key = SymmetricKey(size: .bits256)
        let raw = key.withUnsafeBytes { Data($0) }
        try upsertKeychainData(raw, account: faceKeyAccount)
        return key
    }

    private static func readKeychainData(account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainStoreError.keychainFailure(status)
        }
        return item as? Data
    }

    private static func upsertKeychainData(_ data: Data, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainStoreError.keychainFailure(addStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainStoreError.keychainFailure(status)
        }
    }

    private static func deleteKeychainItem(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

