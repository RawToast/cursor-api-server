@testable import CursorAPICore
import XCTest

final class ConnectivityCheckTests: XCTestCase {
    func testConnectivityCheckUsesHarness() async throws {
        let recorder = ConnectivityRecorder()
        let check = CursorSDKConnectivityCheck(harness: ConnectivityHarness(recorder: recorder))
        let settings = CursorAPISettings(
            cursorAPIKey: "crsr_test",
            backendBaseURL: "https://transport.example",
            localAgentEndpoint: "/sdk/run"
        )

        let output = try await check.run(settings: settings, timeoutNanoseconds: 1_000_000_000)

        XCTAssertEqual(output.text, "OK")
        let recorded = await recorder.recordedRequest()
        let request = try XCTUnwrap(recorded)
        XCTAssertEqual(request.model, "composer-2.5-fast")
        XCTAssertTrue(request.prompt.contains("Connectivity check"))
        XCTAssertTrue(request.sessionKey?.hasPrefix("diagnostics:") == true)
    }

    func testSDKSessionStoreReusesAndBoundsAgentIDs() async throws {
        let store = CursorSDKSessionStore(maxEntries: 2)

        let first = await store.agentID(for: "project-a")
        let second = await store.agentID(for: "project-b")
        let firstAgain = await store.agentID(for: "project-a")
        let third = await store.agentID(for: "project-c")
        let secondAfterEviction = await store.agentID(for: "project-b")
        let count = await store.count()

        XCTAssertEqual(first, firstAgain)
        XCTAssertNotEqual(first, second)
        XCTAssertNotEqual(third, first)
        XCTAssertNotEqual(secondAfterEviction, second)
        XCTAssertEqual(count, 2)
    }

    func testSDKSessionStoreDoesNotPersistAnonymousSessions() async throws {
        let store = CursorSDKSessionStore(maxEntries: 2)

        let first = await store.agentID(for: nil)
        let second = await store.agentID(for: nil)
        let empty = await store.agentID(for: "")
        let count = await store.count()

        XCTAssertNotEqual(first, second)
        XCTAssertNotEqual(first, empty)
        XCTAssertEqual(count, 0)
    }

    func testSDKHarnessUsesSavedKeyForLocalPlaceholderTokens() {
        let settings = CursorAPISettings(cursorAPIKey: "crsr_saved")

        XCTAssertEqual(LocalCursorSDKHarness.resolvedCursorAPIKey(from: nil, settings: settings), "crsr_saved")
        XCTAssertEqual(LocalCursorSDKHarness.resolvedCursorAPIKey(from: "Bearer cursor-local", settings: settings), "crsr_saved")
        XCTAssertEqual(LocalCursorSDKHarness.resolvedCursorAPIKey(from: "Bearer CURSOR_API_KEY", settings: settings), "crsr_saved")
        XCTAssertEqual(LocalCursorSDKHarness.resolvedCursorAPIKey(from: "Bearer {env:CURSOR_API_KEY}", settings: settings), "crsr_saved")
    }

    func testSDKHarnessAllowsDirectBearerKeys() {
        let settings = CursorAPISettings(cursorAPIKey: "crsr_saved")

        XCTAssertEqual(LocalCursorSDKHarness.resolvedCursorAPIKey(from: "Bearer crsr_direct", settings: settings), "crsr_direct")
    }

    func testSDKHarnessReportsLockedKeyForLocalPlaceholderTokens() throws {
        let settings = CursorAPISettings(keychainCursorAPIKeyAvailable: true)

        XCTAssertThrowsError(try LocalCursorSDKHarness.resolvedCursorAPIKeyForRequest(from: "Bearer cursor-local", settings: settings)) { error in
            XCTAssertEqual(error as? CursorAPIError, .keychainLocked)
        }
        XCTAssertEqual(try LocalCursorSDKHarness.resolvedCursorAPIKeyForRequest(from: "Bearer crsr_direct", settings: settings), "crsr_direct")

        let payload = OpenAICompatibility.openAIError(CursorAPIError.keychainLocked)
        let error = try XCTUnwrap(payload["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "keychain_locked")
        XCTAssertTrue((error["message"] as? String)?.contains("Unlock Key") == true)
    }

    func testSDKHarnessMapsBridgeStreamAuthErrorsToUnauthorized() {
        XCTAssertEqual(
            LocalCursorSDKHarness.bridgeStreamError(from: [
                "message": "Error",
                "code": "unauthorized",
                "status": 401
            ]),
            .unauthorized
        )
        XCTAssertEqual(
            LocalCursorSDKHarness.bridgeStreamError(from: [
                "message": "Error",
                "code": "internal",
                "status": "401"
            ]),
            .unauthorized
        )
    }
}

private actor ConnectivityRecorder {
    private var request: PreparedChatRequest?

    func record(_ request: PreparedChatRequest) {
        self.request = request
    }

    func recordedRequest() -> PreparedChatRequest? {
        request
    }
}

private struct ConnectivityHarness: CursorSDKHarness {
    let recorder: ConnectivityRecorder

    func stream(prepared: PreparedChatRequest, settings: CursorAPISettings, authorization: String?) -> AsyncThrowingStream<CursorSDKStreamEvent, any Error> {
        AsyncThrowingStream { continuation in
            Task {
                await recorder.record(prepared)
                continuation.yield(.text("OK"))
                continuation.yield(.done(CursorSDKOutput(text: "OK", agentID: "agent-diagnostics", runID: "run-diagnostics")))
                continuation.finish()
            }
        }
    }
}
