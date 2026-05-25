import Combine
import CursorAPICore
import Foundation
import ServiceManagement

@MainActor
final class CursorAPIAppModel: ObservableObject {
    @Published var settings: CursorAPISettings
    @Published var isRunning = false
    @Published var statusText = "Stopped"
    @Published var integrations: [AgentIntegrationStatus] = []
    @Published var lastError: String?
    @Published var needsKeychainPermission = false
    @Published var sdkCheckState: SDKCheckState = .idle
    @Published var isCheckingSDK = false

    private let store = AppSettingsStore()
    private let provisioner = AgentProvisioner()
    private let connectivityCheck = CursorSDKConnectivityCheck()
    private lazy var server = LocalAPIServer(settingsProvider: { [weak self] in
        DispatchQueue.main.sync {
            self?.settings ?? CursorAPISettings()
        }
    })

    enum SDKCheckState: Equatable {
        case idle
        case success(String)
        case failure(String)
    }

    init() {
        var loaded = store.load()
        loaded.launchAtLogin = SMAppService.mainApp.status == .enabled
        settings = loaded
        integrations = provisioner.statuses(settings: loaded)
        updateStatusText()
    }

    var baseURL: String {
        settings.baseURL.absoluteString
    }

    var hasCursorAPIKey: Bool {
        settings.hasCursorAPIKey
    }

    var canStartServer: Bool {
        hasCursorAPIKey && sdkConfigured
    }

    var sdkConfigured: Bool {
        settings.hasCursorSDKConfiguration
    }

    var sdkStatusText: String {
        if !hasCursorAPIKey {
            return "Needs API Key"
        }
        if !sdkConfigured {
            return "Setup Needed"
        }
        return "Ready"
    }

    var canCheckSDK: Bool {
        hasCursorAPIKey && sdkConfigured && !isCheckingSDK
    }

    func startServer(allowKeychainPrompt: Bool = true) {
        guard hasCursorAPIKey else {
            isRunning = false
            statusText = "Enter a Cursor API key to start the local API"
            lastError = nil
            return
        }
        guard sdkConfigured else {
            isRunning = false
            statusText = "Configure SDK transport to use Composer"
            lastError = nil
            return
        }
        do {
            settings = try store.resolvingCursorAPIKey(in: settings, allowUserPrompt: allowKeychainPrompt)
            store.save(settings)
            settings.keychainCursorAPIKeyAvailable = true
            try server.start(port: settings.port)
            isRunning = true
            needsKeychainPermission = false
            updateStatusText()
            lastError = nil
        } catch AppSettingsStoreError.keychainPermissionRequired {
            isRunning = false
            needsKeychainPermission = true
            statusText = "Click Start to allow CursorAPI to read the saved key from Keychain"
            lastError = nil
        } catch AppSettingsStoreError.missingCursorAPIKey {
            isRunning = false
            settings.keychainCursorAPIKeyAvailable = false
            statusText = "Enter a Cursor API key to start the local API"
            lastError = nil
        } catch {
            isRunning = false
            statusText = "Could not start"
            lastError = error.localizedDescription
        }
    }

    func stopServer() {
        server.stop()
        isRunning = false
        needsKeychainPermission = false
        updateStatusText()
    }

    func restartServer() {
        guard canStartServer else {
            stopServer()
            updateStatusText()
            return
        }
        stopServer()
        startServer()
    }

    func saveKeyAndStartIfReady() {
        saveSettings()
        if canStartServer {
            startServer()
        }
    }

    func saveSettings() {
        store.save(settings)
        if settings.hasInlineCursorAPIKey {
            settings.keychainCursorAPIKeyAvailable = true
        }
        sdkCheckState = .idle
        let launchAtLoginError = applyLaunchAtLogin()
        refreshIntegrations()
        if !hasCursorAPIKey || !sdkConfigured {
            stopServer()
        } else if isRunning {
            restartServer()
        } else {
            updateStatusText()
        }
        if let launchAtLoginError {
            lastError = launchAtLoginError
        }
    }

    func apiKeyDidChange() {
        if settings.hasInlineCursorAPIKey {
            needsKeychainPermission = false
        }
        if !canStartServer, isRunning {
            stopServer()
        } else if !isRunning {
            updateStatusText()
        }
    }

    func refreshIntegrations() {
        integrations = provisioner.statuses(settings: settings)
    }

    func install(_ id: AgentIntegrationID) {
        do {
            try provisioner.install(id, settings: settings)
            refreshIntegrations()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func dismissError() {
        lastError = nil
    }

    func checkSDKConnectivity() {
        guard canCheckSDK else {
            sdkCheckState = .failure(sdkConfigured ? "Enter a Cursor API key before checking SDK connectivity." : "Configure SDK transport before checking connectivity.")
            return
        }
        isCheckingSDK = true
        sdkCheckState = .idle
        Task {
            do {
                let resolved = try store.resolvingCursorAPIKey(in: settings, allowUserPrompt: true)
                settings = resolved
                store.save(settings)
                settings.keychainCursorAPIKeyAvailable = true
                needsKeychainPermission = false
                _ = try await connectivityCheck.run(settings: resolved)
                sdkCheckState = .success("SDK transport responded.")
                lastError = nil
            } catch AppSettingsStoreError.keychainPermissionRequired {
                needsKeychainPermission = true
                sdkCheckState = .failure("Allow Keychain access, then run the check again.")
            } catch {
                sdkCheckState = .failure(error.localizedDescription)
            }
            isCheckingSDK = false
            updateStatusText()
        }
    }

    private func updateStatusText() {
        if isRunning {
            statusText = sdkConfigured ? "Listening on \(baseURL)" : "Listening on \(baseURL); SDK transport setup needed"
        } else if needsKeychainPermission {
            statusText = "Click Start to allow CursorAPI to read the saved key from Keychain"
        } else if !hasCursorAPIKey {
            statusText = "Enter a Cursor API key to start the local API"
        } else if !sdkConfigured {
            statusText = "Configure SDK transport to use Composer"
        } else {
            statusText = "Ready to start local API"
        }
    }

    private func applyLaunchAtLogin() -> String? {
        do {
            if settings.launchAtLogin {
                if SMAppService.mainApp.status != .enabled {
                    try SMAppService.mainApp.register()
                }
            } else if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            }
            return nil
        } catch {
            return "Could not update launch at login: \(error.localizedDescription)"
        }
    }
}
