import type { JsonRpcTransport } from "./transport.js";

export const DEFAULT_MCP_PROTOCOL_VERSION = "2024-11-05";

export type McpServerConfig =
  | ({ name: string } & McpStdioServerConfig)
  | ({ name: string } & McpRemoteServerConfig);

export type McpStoredServerConfig =
  | McpStdioServerConfig
  | McpRemoteServerConfig;

export type McpStdioServerConfig = {
  type?: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type McpRemoteServerConfig = {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  protocolVersion?: string;
};

type JsonRpcId = string | number;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export interface McpJsonRpcClientOptions {
  protocolVersion?: string;
}

/** Pure JSON-RPC client — transport and timeout are injected. No fs/spawn/process. */
export class McpJsonRpcClient {
  private nextId = 1;
  private pending = new Map<JsonRpcId, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private closed = false;

  constructor(
    private transport: JsonRpcTransport,
    private defaultTimeoutMs = 30_000,
    private options: McpJsonRpcClientOptions = {},
  ) {
    transport.onData((chunk) => {
      this.buffer += chunk.toString("utf-8");
      this.drain();
    });
    transport.onClose(() => {
      this.closed = true;
      this.rejectAll(new Error("MCP transport closed"));
    });
    transport.onError((err) => {
      this.rejectAll(err);
    });
  }

  async initialize(): Promise<unknown> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: this.options.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "tiny-agent-mcp", version: "0.1.0" },
    });
    this.sendNotification("notifications/initialized");
    return result;
  }

  async listTools(timeoutMs?: number): Promise<unknown> {
    return this.sendRequest("tools/list", {}, timeoutMs);
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.sendRequest("tools/call", { name, arguments: args }, timeoutMs);
  }

  sendRequest(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP transport closed"));
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${effectiveTimeout}ms)`));
      }, effectiveTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    this.transport.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  disconnect(): void {
    this.closed = true;
    this.rejectAll(new Error("MCP client disconnected"));
    this.transport.destroy();
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private drain(): void {
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) return;
      const raw = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (raw.length === 0) continue;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(raw) as JsonRpcMessage; } catch { continue; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.result !== undefined) p.resolve(msg.result);
        else if (msg.error !== undefined) {
          p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        }
      }
    }
  }
}
