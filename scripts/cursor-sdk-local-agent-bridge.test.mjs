import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  bridgePrompt,
  clientForwardingMcpServerSource,
  clientMcpToolDefinitions,
  localAgentCreateOptions,
  localAgentSendOptions,
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

  it("normalizes local client MCP forwarding tools with direct payload fields", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "client_glob",
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

  it("keeps dynamic harness MCP tools with direct payload fields as client MCP calls", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        file_path: "marker.txt",
        contents: "ok"
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

  it("unwraps common dynamic client tool schema wrappers", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "wrapped_write_file",
        parameters: {
          json_schema: {
            name: "wrapped_write_file",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              },
              required: ["path", "content"]
            }
          }
        }
      }
    ]);

    expect(tools.find((tool) => tool.name === "wrapped_write_file")).toMatchObject({
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"]
      }
    });
    expect(validateClientMcpToolCall(tools, "wrapped_write_file", { path: "marker.txt" })).toBe("Missing required argument for wrapped_write_file: content");
    expect(validateClientMcpToolCall(tools, "wrapped_write_file", { path: "marker.txt", content: "ok" })).toBe(null);
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

  it("validates dynamic client MCP schemas with local references", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "ref_write_file",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            target: { $ref: "#/$defs/fileTarget" },
            metadata: { $ref: "#/definitions/metadata" },
            format: { anyOf: [{ $ref: "#/$defs/format" }, { type: "null" }] }
          },
          required: ["target", "metadata"],
          $defs: {
            fileTarget: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                mode: { type: "string", enum: ["create", "overwrite"] }
              },
              required: ["path", "mode"]
            },
            format: { type: "string", enum: ["text", "markdown"] }
          },
          definitions: {
            metadata: {
              type: "object",
              additionalProperties: false,
              properties: {
                tags: { type: "array", items: { type: "string" }, minItems: 1 }
              },
              required: ["tags"]
            }
          }
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx" },
      metadata: { tags: ["ui"] }
    })).toBe("Missing required argument for ref_write_file.target: mode");
    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx", mode: "append" },
      metadata: { tags: ["ui"] }
    })).toContain("expected one of");
    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx", mode: "create" },
      metadata: { tags: [42] }
    })).toBe("Invalid value for ref_write_file.metadata.tags[0]: expected string");
    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx", mode: "create" },
      metadata: { tags: ["ui"] },
      format: null
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx", mode: "create" },
      metadata: { tags: ["ui"] },
      format: "markdown"
    })).toBe(null);
  });

  it("validates dynamic client MCP scalar constraints", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "constrained_search",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 2, maxLength: 12, pattern: "^[A-Za-z0-9_]+$" },
            limit: { type: "integer", minimum: 1, maximum: 50, multipleOf: 5 }
          },
          required: ["query", "limit"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "", limit: 5 })).toBe("Invalid value for constrained_search.query: expected at least 2 character(s)");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo app", limit: 5 })).toContain("expected to match pattern");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app_name", limit: 5 })).toBe("Invalid value for constrained_search.query: expected at most 12 character(s)");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app", limit: 0 })).toBe("Invalid value for constrained_search.limit: expected >= 1");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app", limit: 55 })).toBe("Invalid value for constrained_search.limit: expected <= 50");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app", limit: 7 })).toBe("Invalid value for constrained_search.limit: expected a multiple of 5");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app", limit: 10 })).toBe(null);
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

  it("bundles referenced schema validation into the generated MCP forwarding server", () => {
    const source = clientForwardingMcpServerSource([
      {
        name: "ref_write_file",
        parameters: {
          type: "object",
          properties: {
            target: { $ref: "#/$defs/fileTarget" }
          },
          required: ["target"],
          $defs: {
            fileTarget: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["create"] }
              },
              required: ["mode"]
            }
          }
        }
      }
    ]);
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ref_write_file",
        arguments: {
          target: { mode: "append" }
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

  it("uses SDK-compatible local options that do not wedge local runs", () => {
    const input = {
      apiKey: "test-key",
      model: "composer-2.5",
      workingDirectory: "/tmp/project",
      clientTools: []
    };

    const createOptions = localAgentCreateOptions(input);
    const sendOptions = localAgentSendOptions(input);

    expect(createOptions.local).toEqual({
      cwd: "/tmp/project"
    });
    expect(createOptions.local).not.toHaveProperty("sandboxOptions");
    expect(createOptions.local).not.toHaveProperty("settingSources");
    expect(sendOptions).toEqual({
      model: { id: "composer-2.5" }
    });
    expect(sendOptions).not.toHaveProperty("local");
  });
});
