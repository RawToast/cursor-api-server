@testable import CursorAPICore
import XCTest

final class ProtobufTests: XCTestCase {
    func testRunRequestContainsPromptAndModel() {
        let request = CursorSDKProto.runRequest(agentID: "agent-id", messageID: "message-id", modelID: "composer-2.5", prompt: "hello")
        let fields = Proto.decodeFields(request)
        XCTAssertEqual(fields.count, 1)
        guard case .bytes(let runEnvelope)? = fields.first?.value else {
            XCTFail("Expected envelope")
            return
        }
        let runFields = Proto.decodeFields(runEnvelope)
        XCTAssertEqual(Proto.stringField(runFields, 5), "agent-id")
        XCTAssertEqual(Proto.stringField(runFields, 13), "sdk")
    }

    func testConnectFrameRoundTrip() {
        let payload = Data("abc".utf8)
        let frame = ConnectProto.frame(payload)
        XCTAssertEqual(ConnectProto.frames(from: frame), [payload])
    }

    func testRequestContextDecode() {
        let context = CursorSDKProto.requestContextResult(id: 42, execID: "exec-1")
        let fields = Proto.decodeFields(context)
        guard case .bytes(let execMessage)? = fields.first(where: { $0.number == 2 })?.value else {
            XCTFail("Expected exec message")
            return
        }
        let serverLikeFrame = Proto.message([Proto.messageField(2, execMessage)])
        XCTAssertEqual(CursorSDKRequestContext.decode(serverLikeFrame), CursorSDKRequestContext(id: 42, execID: "exec-1"))
    }

    func testLocalHarnessUsesSDKRunIDPrefix() {
        let runID = LocalCursorSDKHarness.newRunID()
        XCTAssertTrue(runID.hasPrefix("run-"))
        XCTAssertFalse(runID.hasPrefix("msg-"))
    }

    func testDetectsSDKTurnEndedMarker() {
        let turnEnded = Proto.message([Proto.varintField(2, 1)])
        let interaction = Proto.message([Proto.messageField(14, turnEnded)])
        let frame = Proto.message([Proto.messageField(1, interaction)])

        XCTAssertTrue(CursorSDKStreamMarkers.hasTurnEnded(frame))
        XCTAssertFalse(CursorSDKStreamMarkers.hasTurnEnded(Proto.message([Proto.messageField(1, Proto.message([]))])))
    }

    func testDetectsSDKToolCallMarkers() {
        let shellArgs = Proto.message([Proto.stringField(1, "pwd")])
        let execShell = Proto.message([Proto.messageField(2, shellArgs)])
        let execFrame = Proto.message([Proto.messageField(2, execShell)])

        let interactionShell = Proto.message([Proto.messageField(1, shellArgs)])
        let toolCallUpdate = Proto.message([Proto.messageField(2, interactionShell)])
        let interaction = Proto.message([Proto.messageField(2, toolCallUpdate)])
        let interactionFrame = Proto.message([Proto.messageField(1, interaction)])

        let context = CursorSDKProto.requestContextResult(id: 42, execID: "exec-1")
        let contextFields = Proto.decodeFields(context)
        guard case .bytes(let execMessage)? = contextFields.first(where: { $0.number == 2 })?.value else {
            XCTFail("Expected exec message")
            return
        }
        let contextFrame = Proto.message([Proto.messageField(2, execMessage)])

        XCTAssertTrue(CursorSDKStreamMarkers.hasToolCall(execFrame))
        XCTAssertTrue(CursorSDKStreamMarkers.hasToolCall(interactionFrame))
        XCTAssertFalse(CursorSDKStreamMarkers.hasToolCall(contextFrame))
    }

    func testDecodesSDKMCPArgsMap() throws {
        let mcpArgs = Proto.message([
            Proto.stringField(1, "write_file"),
            Proto.messageField(2, protoValueMapEntry("file_path", protoStringValue("src/App.tsx"))),
            Proto.messageField(2, protoValueMapEntry("overwrite", protoBoolValue(true))),
            Proto.stringField(3, "call-mcp-1"),
            Proto.stringField(4, "filesystem"),
            Proto.stringField(5, "write_file")
        ])
        let mcpTool = Proto.message([Proto.messageField(1, mcpArgs)])
        let toolCallUpdate = Proto.message([Proto.messageField(2, Proto.message([Proto.messageField(15, mcpTool)]))])
        let interaction = Proto.message([Proto.messageField(2, toolCallUpdate)])
        let frame = Proto.message([Proto.messageField(1, interaction)])

        var decoder = CursorSDKFrameDecoder()
        let events = decoder.push(frame)

        guard case .toolCall(let toolCall)? = events.first else {
            XCTFail("Expected MCP tool call")
            return
        }
        XCTAssertEqual(toolCall.name, "mcp")
        XCTAssertEqual(toolCall.arguments["name"]?.stringValue, "write_file")
        XCTAssertEqual(toolCall.arguments["providerIdentifier"]?.stringValue, "filesystem")
        XCTAssertEqual(toolCall.arguments["toolName"]?.stringValue, "write_file")
        XCTAssertEqual(toolCall.arguments["toolCallId"]?.stringValue, "call-mcp-1")
        let args = try XCTUnwrap(toolCall.arguments["args"]?.objectValue)
        XCTAssertEqual(args["file_path"]?.stringValue, "src/App.tsx")
        XCTAssertEqual(args["overwrite"], .bool(true))
    }

    func testNativeTransportConsumesRequestContextBeforeTurnEndDetection() {
        let context = CursorSDKProto.requestContextResult(id: 42, execID: "exec-1")
        let fields = Proto.decodeFields(context)
        guard case .bytes(let execMessage)? = fields.first(where: { $0.number == 2 })?.value else {
            XCTFail("Expected exec message")
            return
        }
        let turnEnded = Proto.message([Proto.varintField(2, 1)])
        let interaction = Proto.message([Proto.messageField(14, turnEnded)])
        let combined = Proto.message([
            Proto.messageField(2, execMessage),
            Proto.messageField(1, interaction)
        ])

        let beforeContext = CursorSDKFrameRouter.action(for: combined, requestContextAlreadySent: false)
        XCTAssertEqual(beforeContext.requestContext, CursorSDKRequestContext(id: 42, execID: "exec-1"))
        XCTAssertFalse(beforeContext.shouldForwardToDecoder)
        XCTAssertFalse(beforeContext.isTurnEnded)

        let afterContext = CursorSDKFrameRouter.action(for: combined, requestContextAlreadySent: true)
        XCTAssertNil(afterContext.requestContext)
        XCTAssertTrue(afterContext.shouldForwardToDecoder)
        XCTAssertTrue(afterContext.isTurnEnded)
        XCTAssertFalse(afterContext.hasToolCall)
    }

    private func protoValueMapEntry(_ key: String, _ value: Data) -> Data {
        Proto.message([
            Proto.stringField(1, key),
            Proto.messageField(2, value)
        ])
    }

    private func protoStringValue(_ value: String) -> Data {
        Proto.message([Proto.stringField(3, value)])
    }

    private func protoBoolValue(_ value: Bool) -> Data {
        Proto.message([Proto.boolField(4, value)])
    }
}
