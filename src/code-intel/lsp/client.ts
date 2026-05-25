import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
} from "./protocol.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type NotificationWaiter = {
  predicate: (notification: JsonRpcNotification) => boolean;
  resolve: (notification: JsonRpcNotification) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class LspClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly waiters: NotificationWaiter[] = [];
  private stderr = "";

  constructor(
    private readonly options: {
      command: string[];
      cwd: string;
      timeoutMs: number;
    },
  ) {}

  start(): Promise<void> {
    if (this.child) {
      return Promise.resolve();
    }

    const [command, ...args] = this.options.command;
    if (!command) {
      return Promise.reject(new Error("LSP server command is empty"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(command, args, {
        cwd: this.options.cwd,
        stdio: "pipe",
      });
      this.child = child;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`LSP server did not start within ${this.options.timeoutMs}ms`));
          child.kill();
        }
      }, this.options.timeoutMs);

      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });

      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });

      child.stdout.on("data", (chunk: Buffer) => {
        this.onData(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        this.stderr += chunk.toString("utf-8");
        if (this.stderr.length > 20000) {
          this.stderr = this.stderr.slice(-20000);
        }
      });

      child.once("exit", (code, signal) => {
        const error = new Error(
          `LSP server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();

        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      });
    });
  }

  async initialize(params: unknown): Promise<unknown> {
    await this.start();
    const result = await this.request("initialize", params);
    this.notify("initialized", {});
    return result;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, this.options.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  waitForNotification(
    predicate: (notification: JsonRpcNotification) => boolean,
    timeoutMs = this.options.timeoutMs,
  ): Promise<JsonRpcNotification> {
    const existingIndex = this.notifications.findIndex(predicate);
    if (existingIndex >= 0) {
      const [existing] = this.notifications.splice(existingIndex, 1);
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new Error("Timed out waiting for LSP notification"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return;
    }

    try {
      await this.request("shutdown");
    } catch {
      // Shutdown failures should not hide the original command result.
    }

    try {
      this.notify("exit");
    } catch {
      // The server may already be gone.
    }

    await new Promise<void>((resolve) => {
      const child = this.child;
      if (!child || child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  getStderr(): string {
    return this.stderr;
  }

  private send(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error("LSP server stdin is not writable");
    }

    const payload = JSON.stringify(message);
    const bytes = Buffer.byteLength(payload, "utf-8");
    child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${payload}`);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!contentLengthMatch) {
        throw new Error("LSP message missing Content-Length header");
      }

      const contentLength = Number(contentLengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.onMessage(JSON.parse(body) as JsonRpcMessage);
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isJsonRpcRequest(message)) {
      this.respondToServerRequest(message.id, message.method);
      return;
    }

    if (isJsonRpcNotification(message)) {
      const waiterIndex = this.waiters.findIndex((waiter) =>
        waiter.predicate(message),
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }

      this.notifications.push(message);
      if (this.notifications.length > 100) {
        this.notifications.shift();
      }
    }
  }

  private respondToServerRequest(id: JsonRpcId, method: string): void {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      result = [];
    }

    this.send({ jsonrpc: "2.0", id, result });
  }
}
