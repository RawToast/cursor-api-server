import Foundation
import LocalAuthentication
import Security

public enum AppSettingsStoreError: Error, LocalizedError, Equatable {
    case keychainPermissionRequired
    case missingCursorAPIKey

    public var errorDescription: String? {
        switch self {
        case .keychainPermissionRequired:
            return "macOS needs permission before \(CursorAPIBrand.displayName) can read the saved API key from Keychain."
        case .missingCursorAPIKey:
            return "Enter a Cursor API key to start the local API."
        }
    }
}

public final class AppSettingsStore: @unchecked Sendable {
    public static let defaultKeychainService = "ai.standardagents.apiforcursor"
    public static let legacyKeychainService = "ai.standardagents.cursorapi"

    private let defaults: UserDefaults
    private let environment: [String: String]
    private let bundledTransportDefaults: @Sendable () -> [String: String]
    private let keychainService: String
    private let legacyKeychainServices: [String]
    private let keychainAccount: String
    private let key = "CursorAPI.settings.v1"
    private let queue = DispatchQueue(label: "CursorAPI.AppSettingsStore")

    public init(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundledTransportDefaults: @escaping @Sendable () -> [String: String] = AppSettingsStore.loadBundledTransportDefaults,
        keychainService: String = AppSettingsStore.defaultKeychainService,
        legacyKeychainServices: [String] = [AppSettingsStore.legacyKeychainService],
        keychainAccount: String = "cursor-api-key"
    ) {
        self.defaults = defaults
        self.environment = environment
        self.bundledTransportDefaults = bundledTransportDefaults
        self.keychainService = keychainService
        self.legacyKeychainServices = legacyKeychainServices
        self.keychainAccount = keychainAccount
    }

    public func load() -> CursorAPISettings {
        queue.sync {
            if let data = defaults.data(forKey: key),
               var value = try? JSONDecoder().decode(CursorAPISettings.self, from: data) {
                applyTransportDefaults(to: &value, from: bundledTransportDefaults(), onlyWhenMissing: true)
                applyEnvironmentDefaults(to: &value, onlyWhenMissing: true)
                value.keychainCursorAPIKeyAvailable = value.hasInlineCursorAPIKey || keychainAPIKeyExists()
                return value
            }
            var value = CursorAPISettings()
            applyTransportDefaults(to: &value, from: bundledTransportDefaults(), onlyWhenMissing: true)
            applyEnvironmentDefaults(to: &value, onlyWhenMissing: false)
            value.keychainCursorAPIKeyAvailable = value.hasInlineCursorAPIKey || keychainAPIKeyExists()
            return value
        }
    }

    public func save(_ settings: CursorAPISettings) {
        queue.sync {
            if settings.hasInlineCursorAPIKey {
                saveKeychainAPIKey(settings.cursorAPIKey)
            } else if !settings.keychainCursorAPIKeyAvailable {
                deleteKeychainAPIKey()
            }
            var persisted = settings
            persisted.cursorAPIKey = ""
            persisted.keychainCursorAPIKeyAvailable = false
            if let data = try? JSONEncoder.cursorAPIPretty.encode(persisted) {
                defaults.set(data, forKey: key)
            }
        }
    }

    public func resolvingCursorAPIKey(in settings: CursorAPISettings, allowUserPrompt: Bool) throws -> CursorAPISettings {
        try queue.sync {
            if settings.hasInlineCursorAPIKey {
                return settings
            }
            guard settings.keychainCursorAPIKeyAvailable || keychainAPIKeyExists() else {
                throw AppSettingsStoreError.missingCursorAPIKey
            }
            var resolved = settings
            resolved.cursorAPIKey = try readKeychainAPIKey(allowUserPrompt: allowUserPrompt)
            resolved.keychainCursorAPIKeyAvailable = true
            return resolved
        }
    }

    private func applyEnvironmentDefaults(to value: inout CursorAPISettings, onlyWhenMissing: Bool) {
        let env = environment
        if (!onlyWhenMissing || value.port == 8787), let envPort = env["CURSOR_API_PORT"], let port = UInt16(envPort) {
            value.port = port
        }
        if !onlyWhenMissing || isMissingCursorAPIBaseURL(value.cursorAPIBaseURL) {
            value.cursorAPIBaseURL = env["CURSOR_API_BASE"] ?? normalizedCursorAPIBaseURL(value.cursorAPIBaseURL)
        }
        if !onlyWhenMissing || value.backendBaseURL.isEmpty {
            value.backendBaseURL = env["CURSOR_BACKEND_BASE_URL"] ?? value.backendBaseURL
        }
        if !onlyWhenMissing || value.localAgentEndpoint.isEmpty {
            value.localAgentEndpoint = env["CURSOR_LOCAL_AGENT_ENDPOINT"] ?? value.localAgentEndpoint
        }
        if !onlyWhenMissing || value.clientVersion.isEmpty || value.clientVersion == "sdk-1.0.13" {
            value.clientVersion = env["CURSOR_SDK_CLIENT_VERSION"] ?? value.clientVersion
        }
    }

    private func applyTransportDefaults(to value: inout CursorAPISettings, from defaults: [String: String], onlyWhenMissing: Bool) {
        if !onlyWhenMissing || isMissingCursorAPIBaseURL(value.cursorAPIBaseURL) {
            value.cursorAPIBaseURL = firstValue(defaults, keys: ["cursorAPIBaseURL", "CURSOR_API_BASE"]) ?? normalizedCursorAPIBaseURL(value.cursorAPIBaseURL)
        }
        if !onlyWhenMissing || value.backendBaseURL.isEmpty {
            value.backendBaseURL = firstValue(defaults, keys: ["backendBaseURL", "CURSOR_BACKEND_BASE_URL"]) ?? value.backendBaseURL
        }
        if !onlyWhenMissing || value.localAgentEndpoint.isEmpty {
            value.localAgentEndpoint = firstValue(defaults, keys: ["localAgentEndpoint", "CURSOR_LOCAL_AGENT_ENDPOINT"]) ?? value.localAgentEndpoint
        }
        if !onlyWhenMissing || value.clientVersion.isEmpty || value.clientVersion == "sdk-1.0.13" {
            value.clientVersion = firstValue(defaults, keys: ["clientVersion", "CURSOR_SDK_CLIENT_VERSION"]) ?? value.clientVersion
        }
    }

    private func firstValue(_ defaults: [String: String], keys: [String]) -> String? {
        for key in keys {
            if let value = defaults[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private func isMissingCursorAPIBaseURL(_ value: String) -> Bool {
        normalizedCursorAPIBaseURL(value).isEmpty
    }

    private func normalizedCursorAPIBaseURL(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == CursorAPISettings.legacyCursorAPIBaseURL ? "" : trimmed
    }

    public static func loadBundledTransportDefaults() -> [String: String] {
        guard let url = Bundle.main.url(forResource: "CursorAPITransportDefaults", withExtension: "plist"),
              let dictionary = NSDictionary(contentsOf: url) as? [String: Any] else {
            return [:]
        }
        return dictionary.compactMapValues { value in
            (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        .filter { !$0.value.isEmpty }
    }

    private func keychainAPIKeyExists() -> Bool {
        for service in keychainLookupServices {
            var query = keychainQuery(service: service)
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            query[kSecUseAuthenticationContext as String] = keychainContext(allowUserPrompt: false)
            let status = SecItemCopyMatching(query as CFDictionary, nil)
            if status == errSecSuccess || status == errSecInteractionNotAllowed {
                return true
            }
        }
        return false
    }

    private func readKeychainAPIKey(allowUserPrompt: Bool) throws -> String {
        for service in keychainLookupServices {
            var query = keychainQuery(service: service)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            query[kSecUseAuthenticationContext as String] = keychainContext(allowUserPrompt: allowUserPrompt)
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecInteractionNotAllowed {
                throw AppSettingsStoreError.keychainPermissionRequired
            }
            if !allowUserPrompt, status != errSecSuccess, status != errSecItemNotFound {
                throw AppSettingsStoreError.keychainPermissionRequired
            }
            guard status != errSecItemNotFound else {
                continue
            }
            guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8), !value.isEmpty else {
                throw AppSettingsStoreError.missingCursorAPIKey
            }
            if service != keychainService {
                saveKeychainAPIKey(value)
                deleteKeychainAPIKey(service: service)
            }
            return value
        }
        throw AppSettingsStoreError.missingCursorAPIKey
    }

    private func saveKeychainAPIKey(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        var query = keychainQuery(service: keychainService)
        if trimmed.isEmpty {
            deleteKeychainAPIKey()
            return
        }
        let data = Data(trimmed.utf8)
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        if status == errSecSuccess {
            SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        } else {
            query[kSecValueData as String] = data
            SecItemAdd(query as CFDictionary, nil)
        }
        for service in legacyKeychainServices where service != keychainService {
            deleteKeychainAPIKey(service: service)
        }
    }

    private func deleteKeychainAPIKey() {
        for service in keychainLookupServices {
            deleteKeychainAPIKey(service: service)
        }
    }

    private func deleteKeychainAPIKey(service: String) {
        SecItemDelete(keychainQuery(service: service) as CFDictionary)
    }

    private func keychainContext(allowUserPrompt: Bool) -> LAContext {
        let context = LAContext()
        context.interactionNotAllowed = !allowUserPrompt
        return context
    }

    private var keychainLookupServices: [String] {
        var services: [String] = []
        for service in [keychainService] + legacyKeychainServices {
            let trimmed = service.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, !services.contains(trimmed) {
                services.append(trimmed)
            }
        }
        return services
    }

    private func keychainQuery(service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keychainAccount
        ]
    }
}
