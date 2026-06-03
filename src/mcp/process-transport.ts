import { spawn, type ChildProcess } from "node:child_process";
import type { JsonRpcTransport } from "./transport.js";

/** Process-based JSON-RPC transport. Spawns a subprocess and wires stdio. */
export class ProcessMcpTransport implements JsonRpcTransport {
  private process: ChildProcess;
  private dataHandlers: Array<(chunk: Buffer) => void> = [];
  private closeHandlers: Array<(code: number | null) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  constructor(
    command: string,
    args: string[],
    env?: Record<string, string>,
    baseEnv?: Record<string, string>,
  ) {
    const mergedEnv = baseEnv ?? process.env;
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...mergedEnv, ...env } : mergedEnv,
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
    try { this.process.stdin?.end(); } catch { /* swallow */ }
    try { this.process.kill(); } catch { /* swallow */ }
  }
}
