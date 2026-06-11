import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  createRuntimeProcess,
  type RuntimeProcessRecord,
} from "../runtime/process-registry.js";
import {
  createCodeIntelRuntime,
  executeCodeIntelCommand,
  type CodeIntelRuntime,
} from "./commands.js";
import type { CodeIntelCommand, CodeIntelEnvelope } from "./types.js";

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

export function codeIntelHostProcessId(
  projectId: string,
  workspaceRoot: string,
): string {
  return `codeq-host:${projectId}:${workspaceRoot}`;
}

export function createCodeIntelHostProcessRecord(input: {
  projectId: string;
  workspaceRoot: string;
  now: string;
  executable?: string;
  statePath?: string;
  logPath?: string;
}): RuntimeProcessRecord {
  return createRuntimeProcess({
    id: codeIntelHostProcessId(input.projectId, input.workspaceRoot),
    kind: "codeq-host",
    owner: {
      scope: "project",
      projectId: input.projectId,
    },
    command: {
      executable: input.executable ?? "tiny-agent",
      args: ["codeq", "host", "--cwd", input.workspaceRoot],
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
  runtime: CodeIntelRuntime,
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
      envelope: await executeCodeIntelCommand(request.command, runtime),
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

export async function serveCodeIntelHost(options: {
  runtime: CodeIntelRuntime;
  input: Readable;
  output: Writable;
  onShutdown?: () => Promise<void> | void;
}): Promise<void> {
  const lines = readline.createInterface({
    input: options.input,
    crlfDelay: Infinity,
  });

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

    const response = await handleCodeIntelHostRequest(options.runtime, request);
    options.output.write(serializeCodeIntelHostResponse(response));
    if (request.type === "codeq.shutdown") {
      await options.onShutdown?.();
      lines.close();
      break;
    }
  }
}

export async function runCodeIntelHostCli(args: string[]): Promise<number> {
  const cwd = parseHostCwd(args);
  await serveCodeIntelHost({
    runtime: createCodeIntelRuntime(cwd),
    input: process.stdin,
    output: process.stdout,
  });
  return 0;
}

function parseHostCwd(args: string[]): string {
  let cwd = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if (arg === "--cwd" && value) {
      cwd = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete codeq host option: ${arg}`);
    }
  }
  return cwd;
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
