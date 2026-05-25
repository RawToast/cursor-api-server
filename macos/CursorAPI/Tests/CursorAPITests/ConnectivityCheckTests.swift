import CursorAPICore
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
