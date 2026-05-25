import Foundation

public struct CursorSDKConnectivityCheck: Sendable {
    private let harness: any CursorSDKHarness

    public init(harness: any CursorSDKHarness = LocalCursorSDKHarness()) {
        self.harness = harness
    }

    public func run(
        settings: CursorAPISettings,
        timeoutNanoseconds: UInt64 = 20_000_000_000
    ) async throws -> CursorSDKOutput {
        var prepared = try OpenAICompatibility.prepareChatRequest(Data(#"""
        {
          "model": "composer-2.5-fast",
          "messages": [
            {
              "role": "user",
              "content": "Connectivity check. Reply with exactly: OK"
            }
          ]
        }
        """#.utf8))
        prepared.sessionKey = "diagnostics:\(UUID().uuidString.lowercased())"
        let request = prepared
        let harness = harness

        return try await withThrowingTaskGroup(of: CursorSDKOutput.self) { group in
            group.addTask {
                try await harness.complete(prepared: request, settings: settings, authorization: nil)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
                throw CursorAPIError.transport("SDK connectivity check timed out.")
            }

            guard let result = try await group.next() else {
                throw CursorAPIError.transport("SDK connectivity check did not return a result.")
            }
            group.cancelAll()
            return result
        }
    }
}
