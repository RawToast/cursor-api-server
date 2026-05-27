import Foundation
import CryptoKit

public enum ConnectProto {
    public static func frame(_ payload: Data, flags: UInt8 = 0) -> Data {
        var data = Data([flags])
        let length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: length) { data.append(contentsOf: $0) }
        data.append(payload)
        return data
    }

    public static func frames(from data: Data) -> [Data] {
        var output: [Data] = []
        var offset = 0
        while data.count - offset >= 5 {
            let lengthBytes = data[(offset + 1)..<(offset + 5)]
            let length = lengthBytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            let end = offset + 5 + Int(length)
            guard end <= data.count else { break }
            output.append(Data(data[(offset + 5)..<end]))
            offset = end
        }
        return output
    }
}

public struct ProtoField: Equatable, Sendable {
    public var number: Int
    public var wireType: Int
    public var value: ProtoValue
}

public enum ProtoValue: Equatable, Sendable {
    case varint(Int)
    case fixed64(UInt64)
    case fixed32(UInt32)
    case bytes(Data)
}

public enum Proto {
    public static func message(_ parts: [Data]) -> Data {
        parts.reduce(into: Data()) { $0.append($1) }
    }

    public static func stringField(_ number: Int, _ value: String?) -> Data {
        guard let value else { return Data() }
        return bytesField(number, Data(value.utf8))
    }

    public static func boolField(_ number: Int, _ value: Bool?) -> Data {
        guard let value else { return Data() }
        return varintField(number, value ? 1 : 0)
    }

    public static func varintField(_ number: Int, _ value: Int?) -> Data {
        guard let value else { return Data() }
        return message([varint((number << 3) | 0), varint(value)])
    }

    public static func messageField(_ number: Int, _ value: Data) -> Data {
        bytesField(number, value)
    }

    public static func bytesField(_ number: Int, _ value: Data) -> Data {
        message([varint((number << 3) | 2), varint(value.count), value])
    }

    public static func varint(_ value: Int) -> Data {
        var value = value
        var output = Data()
        while value >= 0x80 {
            output.append(UInt8((value & 0x7f) | 0x80))
            value >>= 7
        }
        output.append(UInt8(value))
        return output
    }

    public static func decodeFields(_ data: Data) -> [ProtoField] {
        var fields: [ProtoField] = []
        var offset = 0
        while offset < data.count {
            let key = readVarint(data, offset: offset)
            offset = key.offset
            let number = key.value >> 3
            let wireType = key.value & 7
            if wireType == 0 {
                let value = readVarint(data, offset: offset)
                offset = value.offset
                fields.append(ProtoField(number: number, wireType: wireType, value: .varint(value.value)))
            } else if wireType == 1 {
                let end = offset + 8
                guard end <= data.count else { break }
                let value = data[offset..<end].enumerated().reduce(UInt64(0)) { partial, item in
                    partial | (UInt64(item.element) << UInt64(item.offset * 8))
                }
                offset = end
                fields.append(ProtoField(number: number, wireType: wireType, value: .fixed64(value)))
            } else if wireType == 2 {
                let length = readVarint(data, offset: offset)
                offset = length.offset
                let end = offset + length.value
                guard end <= data.count else { break }
                fields.append(ProtoField(number: number, wireType: wireType, value: .bytes(Data(data[offset..<end]))))
                offset = end
            } else if wireType == 5 {
                let end = offset + 4
                guard end <= data.count else { break }
                let value = data[offset..<end].enumerated().reduce(UInt32(0)) { partial, item in
                    partial | (UInt32(item.element) << UInt32(item.offset * 8))
                }
                offset = end
                fields.append(ProtoField(number: number, wireType: wireType, value: .fixed32(value)))
            } else {
                break
            }
        }
        return fields
    }

    public static func readVarint(_ data: Data, offset: Int) -> (value: Int, offset: Int) {
        var value = 0
        var shift = 0
        var cursor = offset
        while cursor < data.count {
            let byte = Int(data[cursor])
            cursor += 1
            value |= (byte & 0x7f) << shift
            if (byte & 0x80) == 0 {
                return (value, cursor)
            }
            shift += 7
        }
        return (value, cursor)
    }

    public static func stringField(_ fields: [ProtoField], _ number: Int) -> String? {
        guard case .bytes(let bytes)? = fields.first(where: { $0.number == number })?.value else { return nil }
        return String(data: bytes, encoding: .utf8)
    }

    public static func dataField(_ fields: [ProtoField], _ number: Int) -> Data? {
        guard case .bytes(let bytes)? = fields.first(where: { $0.number == number })?.value else { return nil }
        return bytes
    }

    public static func numberField(_ fields: [ProtoField], _ number: Int) -> Int? {
        guard case .varint(let value)? = fields.first(where: { $0.number == number })?.value else { return nil }
        return value
    }

    public static func stringFields(_ fields: [ProtoField], _ number: Int) -> [String] {
        fields.compactMap { field in
            guard field.number == number, case .bytes(let bytes) = field.value else { return nil }
            return String(data: bytes, encoding: .utf8)
        }
    }
}

public enum CursorSDKProto {
    private static let agentModeAgent = 1

    public static func runRequest(agentID: String, messageID: String, modelID: String, prompt: String) -> Data {
        let userMessage = Proto.message([
            Proto.stringField(1, prompt),
            Proto.stringField(2, messageID),
            Proto.varintField(4, agentModeAgent)
        ])
        let userMessageAction = Proto.message([Proto.messageField(1, userMessage)])
        let conversationAction = Proto.message([Proto.messageField(1, userMessageAction)])
        let modelDetails = Proto.message([
            Proto.stringField(1, modelID),
            Proto.stringField(3, modelID),
            Proto.stringField(4, modelID)
        ])
        let requestedModel = Proto.message([Proto.stringField(1, modelID)])
        let runRequest = Proto.message([
            Proto.messageField(1, Proto.message([])),
            Proto.messageField(2, conversationAction),
            Proto.messageField(3, modelDetails),
            Proto.messageField(4, Proto.message([])),
            Proto.stringField(5, agentID),
            Proto.stringField(13, "sdk"),
            Proto.messageField(9, requestedModel),
            Proto.varintField(19, 1)
        ])
        return Proto.message([Proto.messageField(1, runRequest)])
    }

    public static func requestContextResult(id: Int, execID: String?) -> Data {
        let env = Proto.message([
            Proto.stringField(1, "SDK OpenCode bridge"),
            Proto.stringField(2, "."),
            Proto.stringField(3, "sh"),
            Proto.boolField(5, false),
            Proto.stringField(10, "UTC"),
            Proto.stringField(11, "."),
            Proto.stringField(21, ".")
        ])
        let requestContext = Proto.message([
            Proto.messageField(4, env),
            Proto.boolField(17, false),
            Proto.boolField(24, false),
            Proto.boolField(32, true),
            Proto.boolField(33, true),
            Proto.boolField(35, false),
            Proto.boolField(36, true),
            Proto.boolField(39, true),
            Proto.boolField(40, true),
            Proto.boolField(41, true),
            Proto.boolField(42, true),
            Proto.boolField(43, true),
            Proto.boolField(44, true),
            Proto.boolField(45, true)
        ])
        let success = Proto.message([Proto.messageField(1, requestContext)])
        let result = Proto.message([Proto.messageField(1, success)])
        let execClientMessage = Proto.message([
            Proto.varintField(1, id),
            Proto.stringField(15, execID),
            Proto.messageField(10, result)
        ])
        return Proto.message([Proto.messageField(2, execClientMessage)])
    }

    public static func stableID(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}
