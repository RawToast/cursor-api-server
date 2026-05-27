import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  bridgePrompt,
  clientForwardingMcpServerSource,
  clientMcpToolDefinitions,
  isForwardableSDKToolCall,
  normalizeSDKToolCall,
  toolCallFromDelta,
  validateClientMcpToolCall
} from "./cursor-sdk-local-agent-bridge.mjs";

describe("Cursor SDK local-agent bridge", () => {
  it("does not cancel SDK glob calls on directory-only partial arguments", () => {
    const partial = normalizeSDKToolCall({
      type: "glob",
      args: { targetDirectory: "." }
    });

    expect(partial).toEqual({
      name: "glob",
      arguments: { targetDirectory: "." }
    });
    expect(isForwardableSDKToolCall(partial)).toBe(false);
  });

  it("allows SDK glob calls once a real pattern is present", () => {
    expect(isForwardableSDKToolCall({ name: "glob", arguments: { globPattern: "**/*.tsx", targetDirectory: "." } })).toBe(true);
    expect(isForwardableSDKToolCall({ name: "glob", arguments: { glob_pattern: "*.tsx", targeting: "src" } })).toBe(true);
    expect(isForwardableSDKToolCall({ name: "glob", arguments: { targeting: "/tmp/project/src/**/*.tsx" } })).toBe(true);
  });

  it("extracts partial tool calls without treating tool-call starts as complete", () => {
    const update = {
      type: "partial-tool-call",
      toolCall: {
        type: "glob",
        args: { targeting: "src" }
      }
    };
    const normalized = normalizeSDKToolCall(toolCallFromDelta(update));

    expect(normalized).toEqual({
      name: "glob",
      arguments: { targeting: "src" }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(false);
  });

  it("requires both provider and tool names for SDK MCP forwarding", () => {
    expect(isForwardableSDKToolCall({ name: "mcp", arguments: { providerIdentifier: "client" } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "mcp", arguments: { providerIdentifier: "client", toolName: "glob" } })).toBe(true);
  });

  it("normalizes local client MCP forwarding tools back to SDK tool names", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "client_shell",
        args: {
          command: "npm test",
          timeout: 120000
        }
      }
    });

    expect(normalized).toEqual({
      name: "shell",
      arguments: {
        command: "npm test",
        timeout: 120000
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes direct forwarding MCP tool events back to SDK tool names", () => {
    const normalized = normalizeSDKToolCall({
      type: "client_shell",
      args: {
        command: "npm test",
        timeout: 120000
      }
    });

    expect(normalized).toEqual({
      name: "shell",
      arguments: {
        command: "npm test",
        timeout: 120000
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes SDK tool calls that use OpenAI-style argument keys", () => {
    const normalized = normalizeSDKToolCall({
      name: "glob",
      arguments: {
        targetDirectory: "src",
        globPattern: "**/*.tsx"
      }
    });

    expect(normalized).toEqual({
      name: "glob",
      arguments: {
        targetDirectory: "src",
        globPattern: "**/*.tsx"
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes local client MCP forwarding tools with alternate payload keys", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "client_glob",
        arguments: JSON.stringify({
          targetDirectory: "src",
          globPattern: "**/*.tsx"
        })
      }
    });

    expect(normalized).toEqual({
      name: "glob",
      arguments: {
        targetDirectory: "src",
        globPattern: "**/*.tsx"
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("keeps dynamic harness MCP tools as client MCP calls", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    });

    expect(normalized).toEqual({
      name: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes direct dynamic harness MCP tool events to SDK MCP calls", () => {
    const normalized = normalizeSDKToolCall({
      type: "probe_write_file",
      args: {
        file_path: "marker.txt",
        contents: "ok"
      }
    }, [
      {
        name: "probe_write_file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ]);

    expect(normalized).toEqual({
      name: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("exposes dynamic client tool schemas through the forwarding MCP server", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "probe_write_file",
        description: "Writes a marker through the harness MCP server.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ]);

    expect(tools.some((tool) => tool.name === "client_shell")).toBe(true);
    expect(tools.find((tool) => tool.name === "probe_write_file")).toMatchObject({
      description: "Writes a marker through the harness MCP server.",
      inputSchema: {
        additionalProperties: false,
        required: ["file_path", "contents"]
      }
    });
  });

  it("rejects unknown or incomplete client MCP forwarding calls internally", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "probe_write_file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "missing_tool", {})).toContain("Unknown client MCP forwarding tool");
    expect(validateClientMcpToolCall(tools, "probe_write_file", { file_path: "marker.txt" })).toBe("Missing required argument for probe_write_file: contents");
    expect(validateClientMcpToolCall(tools, "probe_write_file", { file_path: "marker.txt", contents: "" })).toBe(null);
  });

  it("validates nested dynamic client MCP schemas before accepting forwarding calls", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "call_mcp_tool",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            serverName: { type: "string" },
            toolName: { type: "string" },
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                filePath: { type: "string" },
                content: { type: "string" },
                mode: { type: "string", enum: ["create", "overwrite"] },
                metadata: {
                  type: "object",
                  properties: {
                    tags: { type: "array", items: { type: "string" }, minItems: 1 }
                  },
                  required: ["tags"],
                  additionalProperties: false
                },
                format: { anyOf: [{ type: "string", enum: ["text", "markdown"] }, { type: "null" }] }
              },
              required: ["filePath", "content", "mode", "metadata"]
            }
          },
          required: ["serverName", "toolName", "input"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "create" }
    })).toBe("Missing required argument for call_mcp_tool.input: metadata");
    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "append", metadata: { tags: ["ui"] } }
    })).toContain("expected one of");
    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "create", metadata: { tags: [42] } }
    })).toBe("Invalid value for call_mcp_tool.input.metadata.tags[0]: expected string");
    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "create", metadata: { tags: ["ui"] }, extra: true }
    })).toBe("Unexpected argument for call_mcp_tool.input: extra");
    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "create", metadata: { tags: ["ui"] }, format: null }
    })).toBe(null);
  });

  it("bundles nested schema validation into the generated MCP forwarding server", () => {
    const source = clientForwardingMcpServerSource([
      {
        name: "call_mcp_tool",
        parameters: {
          type: "object",
          properties: {
            serverName: { type: "string" },
            input: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["create"] }
              },
              required: ["mode"]
            }
          },
          required: ["serverName", "input"]
        }
      }
    ]);
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "call_mcp_tool",
        arguments: {
          serverName: "filesystem",
          input: { mode: "append" }
        }
      }
    };

    const result = spawnSync(process.execPath, ["-e", source], {
      input: `${JSON.stringify(message)}\n`,
      encoding: "utf8",
      timeout: 1000
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const response = JSON.parse(result.stdout.trim());
    expect(response.error.message).toContain("expected one of");
  });

  it("tells the SDK to use client MCP tools instead of built-in local tools", () => {
    const prompt = bridgePrompt("USER: create a file");

    expect(prompt).toContain("client_shell");
    expect(prompt).toContain("Do not use the SDK built-in shell");
  });
});
