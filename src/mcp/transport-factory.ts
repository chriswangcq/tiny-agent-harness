import type { McpServerConfig, McpStdioServerConfig } from "./client.js";
import { HttpMcpTransport } from "./http-transport.js";
import { ProcessMcpTransport } from "./process-transport.js";
import type { JsonRpcTransport } from "./transport.js";

export function createMcpTransport(config: McpServerConfig): JsonRpcTransport {
  if (config.type === "http" || config.type === "sse") {
    if (!config.url) {
      throw new Error(`MCP ${config.type} server requires url`);
    }
    return new HttpMcpTransport({
      url: config.url,
      headers: config.headers,
      mode: config.type,
      protocolVersion: config.protocolVersion ?? defaultRemoteProtocolVersion(config.type),
    });
  }

  const stdioConfig = config as { name: string } & McpStdioServerConfig;
  if (!stdioConfig.command) {
    throw new Error("MCP stdio server requires command");
  }
  return new ProcessMcpTransport(
    stdioConfig.command,
    stdioConfig.args ?? [],
    stdioConfig.env,
  );
}

function defaultRemoteProtocolVersion(type: "http" | "sse"): string | undefined {
  return type === "http" ? "2025-03-26" : undefined;
}
