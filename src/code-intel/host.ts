import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RuntimeProcessRecord } from "../runtime/process-registry.js";
import {
  createResidentHostProcessRecord,
  listenResidentHostSocket,
  requestResidentHostJson,
  residentHostProcessId,
} from "../runtime/resident-host.js";
import {
  createCodeIntelRuntime,
  executeCodeIntelCommand,
  type CodeIntelRuntime,
} from "./commands.js";
import type { CodeIntelBackend, CodeIntelCommand, CodeIntelEnvelope } from "./types.js";

export type CodeIntelHostExecuteRequest = {
  schemaVersion: 1;
  id: string;
  type: "codeq.execute";
  command: CodeIntelCommand;
};

export type CodeIntelHostShutdownRequest = {
  schemaVersion: 1;
  id: string;
  type: "codeq.shutdown";
  reason?: string;
};

export type CodeIntelHostRequest =
  | CodeIntelHostExecuteRequest
  | CodeIntelHostShutdownRequest;

export type CodeIntelHostResponse =
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "codeq.execute.result";
      envelope: CodeIntelEnvelope;
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "codeq.shutdown.result";
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: false;
      type: "codeq.error";
      error: {
        code: "BAD_REQUEST" | "CODEQ_ERROR";
        message: string;
      };
    };

export type CodeIntelHostRequestHandler = (
  request: CodeIntelHostRequest,
) => Promise<CodeIntelHostResponse>;

export type CodeIntelHostCommandExecutor = {
  execute(command: CodeIntelCommand): Promise<CodeIntelEnvelope>;
  dispose(): Promise<void>;
};

export class CodeIntelHostRuntime implements CodeIntelHostCommandExecutor {
  private backend?: CodeIntelBackend;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly runtime: CodeIntelRuntime) {}

  async execute(command: CodeIntelCommand): Promise<CodeIntelEnvelope> {
    const task = this.queue.then(() => this.executeSerial(command));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue.catch(() => undefined);
    const backend = this.backend;
    this.backend = undefined;
    await backend?.dispose();
  }

  private async executeSerial(command: CodeIntelCommand): Promise<CodeIntelEnvelope> {
    if (this.disposed) {
      throw new Error("CodeQ host runtime is disposed");
    }
    const backend = codeIntelCommandUsesBackend(command)
      ? this.ensureBackend()
      : undefined;
    return await executeCodeIntelCommand(
      command,
      this.runtime,
      backend ? { backend, disposeBackend: false } : {},
    );
  }

  private ensureBackend(): CodeIntelBackend {
    if (!this.backend) {
      this.backend = this.runtime.createBackend();
    }
    return this.backend;
  }
}

export function createCodeIntelHostRuntime(
  runtime: CodeIntelRuntime,
): CodeIntelHostRuntime {
  return new CodeIntelHostRuntime(runtime);
}

export function codeIntelHostProcessId(
  runId: string,
): string {
  return residentHostProcessId("codeq-host", runId);
}

export function createCodeIntelHostProcessRecord(input: {
  runId: string;
  workspaceRoot: string;
  socketPath: string;
  now: string;
  executable?: string;
  statePath?: string;
  logPath?: string;
}): RuntimeProcessRecord {
  return createResidentHostProcessRecord({
    kind: "codeq-host",
    runId: input.runId,
    socketPath: input.socketPath,
    command: {
      executable: input.executable ?? "tiny-agent",
      args: [
        "codeq",
        "host",
        "--cwd",
        input.workspaceRoot,
        "--socket",
        input.socketPath,
      ],
      cwd: input.workspaceRoot,
    },
    now: input.now,
    statePath: input.statePath,
    logPath: input.logPath,
    metadata: {
      workspaceRoot: input.workspaceRoot,
    },
  });
}

export async function handleCodeIntelHostRequest(
  executor: CodeIntelHostCommandExecutor,
  request: CodeIntelHostRequest,
): Promise<CodeIntelHostResponse> {
  if (request.type === "codeq.shutdown") {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "codeq.shutdown.result",
    };
  }

  try {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "codeq.execute.result",
      envelope: await executor.execute(request.command),
    };
  } catch (error) {
    return codeIntelHostErrorResponse({
      id: request.id,
      code: "CODEQ_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseCodeIntelHostRequest(raw: string): CodeIntelHostRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid codeq host request JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid codeq host request: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid codeq host request: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid codeq host request: id must be non-empty");
  }
  if (parsed.type === "codeq.shutdown") {
    return parsed as CodeIntelHostShutdownRequest;
  }
  if (parsed.type !== "codeq.execute") {
    throw new Error("Invalid codeq host request: unsupported type");
  }
  if (!isRecord(parsed.command) || typeof parsed.command.kind !== "string") {
    throw new Error("Invalid codeq execute request: command.kind is required");
  }
  return parsed as CodeIntelHostExecuteRequest;
}

export function serializeCodeIntelHostResponse(
  response: CodeIntelHostResponse,
): string {
  return `${JSON.stringify(response)}\n`;
}

export function parseCodeIntelHostResponse(
  raw: string,
  expectedId?: string,
): CodeIntelHostResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid codeq host response JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid codeq host response: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid codeq host response: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid codeq host response: id must be non-empty");
  }
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error(
      `Invalid codeq host response: expected id ${expectedId}, got ${parsed.id}`,
    );
  }
  if (typeof parsed.ok !== "boolean" || typeof parsed.type !== "string") {
    throw new Error("Invalid codeq host response: ok and type are required");
  }
  return parsed as CodeIntelHostResponse;
}

export async function serveCodeIntelHost(options: {
  executor: CodeIntelHostCommandExecutor;
  input: Readable;
  output: Writable;
  onShutdown?: () => Promise<void> | void;
}): Promise<void> {
  const lines = readline.createInterface({
    input: options.input,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      let request: CodeIntelHostRequest;
      try {
        request = parseCodeIntelHostRequest(line);
      } catch (error) {
        options.output.write(
          serializeCodeIntelHostResponse(
            codeIntelHostErrorResponse({
              id: "unknown",
              code: "BAD_REQUEST",
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        continue;
      }

      const response = await handleCodeIntelHostRequest(options.executor, request);
      options.output.write(serializeCodeIntelHostResponse(response));
      if (request.type === "codeq.shutdown") {
        await options.onShutdown?.();
        lines.close();
        break;
      }
    }
  } finally {
    await options.executor.dispose();
  }
}

export async function listenCodeIntelHostSocket(options: {
  socketPath: string;
  handleRequest: CodeIntelHostRequestHandler;
  onShutdown?: () => Promise<void> | void;
}) {
  return await listenResidentHostSocket({
    socketPath: options.socketPath,
    handleLine: async (line) => {
      const { request, response } = await handleCodeIntelHostSocketLine({
        line,
        handleRequest: options.handleRequest,
      });
      if (request?.type === "codeq.shutdown") {
        await options.onShutdown?.();
      }
      return {
        responseLine: JSON.stringify(response),
        close: request?.type === "codeq.shutdown",
      };
    },
  });
}

export async function requestCodeIntelHostSocket(options: {
  socketPath: string;
  request: CodeIntelHostRequest;
  timeoutMs: number;
}): Promise<CodeIntelHostResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) => parseCodeIntelHostResponse(raw, options.request.id),
  });
}

export async function runCodeIntelHostCli(args: string[]): Promise<number> {
  const { cwd, socketPath } = parseHostOptions(args);
  const executor = createCodeIntelHostRuntime(createCodeIntelRuntime(cwd));
  if (socketPath) {
    try {
      const server = await listenCodeIntelHostSocket({
        socketPath,
        handleRequest: async (request) =>
          handleCodeIntelHostRequest(executor, request),
        onShutdown: async () => executor.dispose(),
      });
      await new Promise<void>((resolve, reject) => {
        server.once("close", resolve);
        server.once("error", reject);
      });
    } finally {
      await executor.dispose();
    }
    return 0;
  }

  await serveCodeIntelHost({
    executor,
    input: process.stdin,
    output: process.stdout,
  });
  return 0;
}

function parseHostOptions(args: string[]): { cwd: string; socketPath?: string } {
  let cwd = process.cwd();
  let socketPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if (arg === "--cwd" && value) {
      cwd = value;
      index += 1;
    } else if (arg === "--socket" && value) {
      socketPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete codeq host option: ${arg}`);
    }
  }
  return { cwd, socketPath };
}

function codeIntelCommandUsesBackend(command: CodeIntelCommand): boolean {
  return !(
    command.kind === "capabilities" ||
    (command.kind === "diagnostics" && command.workspace)
  );
}

async function handleCodeIntelHostSocketLine(
  options: {
    line: string;
    handleRequest: CodeIntelHostRequestHandler;
  },
): Promise<{
  request?: CodeIntelHostRequest;
  response: CodeIntelHostResponse;
}> {
  let request: CodeIntelHostRequest;
  try {
    request = parseCodeIntelHostRequest(options.line);
  } catch (error) {
    return {
      response: codeIntelHostErrorResponse({
        id: "unknown",
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  const response = await options.handleRequest(request);
  return { request, response };
}

function codeIntelHostErrorResponse(input: {
  id: string;
  code: "BAD_REQUEST" | "CODEQ_ERROR";
  message: string;
}): CodeIntelHostResponse {
  return {
    schemaVersion: 1,
    id: input.id,
    ok: false,
    type: "codeq.error",
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
