import * as net from "node:net";
import {
  parseWorkbenchServerMessage,
  type WorkbenchCommand,
  type WorkbenchEvent,
  type WorkbenchRequest,
  type WorkbenchResponse,
} from "../runtime/project-workbench.js";

export type TuiWorkbenchClientPort = {
  subscribe(input: {
    selectedRunId?: string;
    onEvent: (event: WorkbenchEvent) => void;
    onError: (error: Error) => void;
  }): Promise<TuiWorkbenchSessionPort>;
};

export type TuiWorkbenchSessionPort = {
  readonly clientId: string;
  command(command: WorkbenchCommand): Promise<Record<string, unknown>>;
  close(): void;
};

export type RuntimeWorkbenchClientOptions = {
  socketPath: string;
  timeoutMs: number;
  newRequestId: () => string;
};

export function createRuntimeWorkbenchClient(
  options: RuntimeWorkbenchClientOptions,
): TuiWorkbenchClientPort {
  return {
    async subscribe(input) {
      const session = new RuntimeWorkbenchSocketSession({
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs,
        newRequestId: options.newRequestId,
        onEvent: input.onEvent,
        onError: input.onError,
      });
      await session.open();
      const response = await session.request({
        schemaVersion: 1,
        id: options.newRequestId(),
        type: "workbench.subscribe",
        selectedRunId: input.selectedRunId,
      });
      const data = requireWorkbenchData(response);
      session.setClientId(requireString(data.clientId, "workbench clientId"));
      return session;
    },
  };
}

type PendingRequest = {
  resolve: (response: WorkbenchResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class RuntimeWorkbenchSocketSession implements TuiWorkbenchSessionPort {
  private readonly socket: net.Socket;
  private readonly timeoutMs: number;
  private readonly newRequestId: () => string;
  private readonly onEvent: (event: WorkbenchEvent) => void;
  private readonly onError: (error: Error) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private closed = false;
  private connected = false;
  private currentClientId = "";

  constructor(input: {
    socketPath: string;
    timeoutMs: number;
    newRequestId: () => string;
    onEvent: (event: WorkbenchEvent) => void;
    onError: (error: Error) => void;
  }) {
    this.socket = net.createConnection(input.socketPath);
    this.timeoutMs = input.timeoutMs;
    this.newRequestId = input.newRequestId;
    this.onEvent = input.onEvent;
    this.onError = input.onError;

    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.once("end", () => this.closeWithError(new Error("Workbench socket ended")));
    this.socket.once("close", () =>
      this.closeWithError(new Error("Workbench socket closed")),
    );
    this.socket.once("error", (error) => this.closeWithError(error));
  }

  get clientId(): string {
    return this.currentClientId;
  }

  async open(): Promise<void> {
    if (this.connected) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        this.socket.off("error", onError);
        this.connected = true;
        resolve();
      };
      const onError = (error: Error) => {
        this.socket.off("connect", onConnect);
        reject(error);
      };
      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
    });
  }

  setClientId(clientId: string): void {
    this.currentClientId = clientId;
  }

  async command(command: WorkbenchCommand): Promise<Record<string, unknown>> {
    const response = await this.request({
      schemaVersion: 1,
      id: this.newRequestId(),
      type: "workbench.command",
      clientId: this.currentClientId,
      command,
    });
    return requireWorkbenchData(response);
  }

  close(): void {
    this.closed = true;
    this.rejectPending(new Error("Workbench socket closed"));
    this.socket.end();
  }

  request(request: WorkbenchRequest): Promise<WorkbenchResponse> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error("Workbench socket is closed"));
    }
    return new Promise<WorkbenchResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Timed out waiting for ${request.type} response`));
      }, this.timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    try {
      const message = parseWorkbenchServerMessage(line);
      if (message.type === "workbench.event") {
        this.onEvent(message.event);
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        this.onError(new Error(`Unexpected workbench response id: ${message.id}`));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPending(error);
    this.onError(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function requireWorkbenchData(response: WorkbenchResponse): Record<string, unknown> {
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  if (!isRecord(response.data)) {
    throw new Error("Invalid workbench response data");
  }
  return response.data;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
