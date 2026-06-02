import { spawn, type ChildProcess } from "node:child_process";
import type { JsonRpcTransport } from "./transport.js";

export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
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

/** Pure JSON-RPC client — transport and timer are injected. */
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
    return this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tiny-agent-mcp", version: "0.1.0" },
    });
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

/** Process-based transport implementing JsonRpcTransport. */
export class ProcessMcpTransport implements JsonRpcTransport {
  private process: ChildProcess;
  private dataHandlers: Array<(chunk: Buffer) => void> = [];
  private closeHandlers: Array<(code: number | null) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  constructor(command: string, args: string[], env?: Record<string, string>) {
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    this.process.stdout?.on("data", (chunk: Buffer) => {
      for (const h of this.dataHandlers) h(chunk);
    });
    this.process.on("close", (code) => {
      for (const h of this.closeHandlers) h(code);
    });
    this.process.on("error", (err) => {
      for (const h of this.errorHandlers) h(err);
    });
  }

  write(data: string): void {
    this.process.stdin?.write(data);
  }
  onData(handler: (chunk: Buffer) => void): void { this.dataHandlers.push(handler); }
  onClose(handler: (code: number | null) => void): void { this.closeHandlers.push(handler); }
  onError(handler: (err: Error) => void): void { this.errorHandlers.push(handler); }
  destroy(): void {
    try { this.process.stdin?.end(); } catch {}
    try { this.process.kill(); } catch {}
  }
}

/** Convenience wrapper — creates ProcessMcpTransport + McpJsonRpcClient. */
export class McpClient extends McpJsonRpcClient {
  constructor(config: McpServerConfig) {
    const transport = new ProcessMcpTransport(config.command, config.args, config.env);
    super(transport);
  }
}
