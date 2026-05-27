import { describe, expect, it } from "vitest";
import { cursorSdkTestExports } from "./cursor-sdk";

describe("Cursor SDK harness", () => {
  it("does not emit incomplete SDK tool-call starts to OpenCode", () => {
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "edit", arguments: {} })).toBe(false);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "write", arguments: { path: "package.json" } })).toBe(false);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "shell", arguments: {} })).toBe(false);
  });

  it("allows SDK tool calls once required execution arguments are available", () => {
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "glob", arguments: {} })).toBe(true);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "write", arguments: { path: "package.json", fileText: "{}" } })).toBe(true);
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "shell", arguments: { command: "npm test" } })).toBe(true);
  });

  it("converts completed SDK streaming edits into OpenCode writes", () => {
    expect(
      cursorSdkTestExports.normalizeSdkToolCallForOpenCode({
        name: "edit",
        arguments: { path: "scripts/verify.mjs", streamContent: "console.log('ok')\n" }
      })
    ).toEqual({
      name: "write",
      arguments: { path: "scripts/verify.mjs", fileText: "console.log('ok')\n" }
    });
    expect(cursorSdkTestExports.isEmittableSdkToolCall({ name: "edit", arguments: { path: "scripts/verify.mjs", streamContent: "x" } })).toBe(
      true
    );
  });

  it("decodes SDK MCP tool args maps", () => {
    const mcpArgs = protoMessage([
      protoStringField(1, "write_file"),
      protoMessageField(2, protoValueMapEntry("file_path", protoStringValue("src/App.tsx"))),
      protoMessageField(2, protoValueMapEntry("overwrite", protoBoolValue(true))),
      protoStringField(3, "call-mcp-1"),
      protoStringField(4, "filesystem"),
      protoStringField(5, "write_file")
    ]);
    const mcpTool = protoMessage([protoMessageField(1, mcpArgs)]);
    const toolCallUpdate = protoMessage([protoMessageField(2, protoMessage([protoMessageField(15, mcpTool)]))]);
    const interaction = protoMessage([protoMessageField(2, toolCallUpdate)]);
    const frame = protoMessage([protoMessageField(1, interaction)]);

    const event = cursorSdkTestExports.decodeLocalAgentServerFrame(frame).find((item) => item.type === "tool_call");

    expect(event).toMatchObject({
      type: "tool_call",
      toolCall: {
        name: "mcp",
        arguments: {
          name: "write_file",
          providerIdentifier: "filesystem",
          toolName: "write_file",
          toolCallId: "call-mcp-1",
          args: {
            file_path: "src/App.tsx",
            overwrite: true
          }
        }
      }
    });
  });
});

function protoMessage(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function protoMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoMessage([protoVarint((fieldNumber << 3) | 2), protoVarint(value.length), value]);
}

function protoStringField(fieldNumber: number, value: string): Uint8Array {
  return protoMessageField(fieldNumber, new TextEncoder().encode(value));
}

function protoValueMapEntry(key: string, value: Uint8Array): Uint8Array {
  return protoMessage([protoStringField(1, key), protoMessageField(2, value)]);
}

function protoStringValue(value: string): Uint8Array {
  return protoMessage([protoStringField(3, value)]);
}

function protoBoolValue(value: boolean): Uint8Array {
  return protoMessage([protoVarint(4 << 3), protoVarint(value ? 1 : 0)]);
}

function protoVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}
