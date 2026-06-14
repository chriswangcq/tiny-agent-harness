import { randomUUID } from "node:crypto";
import { parseCodeIntelArgv } from "./commands.js";
import {
  requestCodeIntelHostSocket,
  runCodeIntelHostCli,
  type CodeIntelHostExecuteRequest,
  type CodeIntelHostResponse,
} from "./host.js";
import { asJson, failureEnvelope } from "./output.js";
import type { CodeIntelEnvelope, CodeIntelErrorCode } from "./types.js";

const DEFAULT_CODEQ_HOST_TIMEOUT_MS = 30_000;

export type CodeIntelClientRequest = {
  socketPath: string;
  request: CodeIntelHostExecuteRequest;
  timeoutMs: number;
};

export type CodeIntelClientDeps = {
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  newRequestId: () => string;
  requestHost: (request: CodeIntelClientRequest) => Promise<CodeIntelHostResponse>;
};

export async function runCodeIntelCli(argv: string[]): Promise<number> {
  if (argv[0] === "host") {
    return await runCodeIntelHostCli(argv.slice(1));
  }

  const envelope = await executeCodeIntelClientArgv(argv, {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: DEFAULT_CODEQ_HOST_TIMEOUT_MS,
    newRequestId: () => `codeq-cli-${randomUUID()}`,
    requestHost: requestCodeIntelHostSocket,
  });
  process.stdout.write(asJson(envelope));
  return envelope.ok ? 0 : 1;
}

export async function executeCodeIntelClientArgv(
  argv: string[],
  deps: CodeIntelClientDeps,
): Promise<CodeIntelEnvelope> {
  try {
    const options = parseCodeIntelClientOptions(argv, deps.env);
    const command = parseCodeIntelArgv(options.commandArgv);
    if (!options.socketPath) {
      return codeIntelClientFailure({
        cwd: deps.cwd,
        code: "server_not_found",
        message:
          "tiny-agent codeq requires a run-scoped CodeQ host socket. Set TAH_CODEQ_HOST_SOCKET or pass --host-socket <path>.",
        retryable: false,
      });
    }

    const response = await deps.requestHost({
      socketPath: options.socketPath,
      timeoutMs: options.timeoutMs ?? deps.timeoutMs,
      request: {
        schemaVersion: 1,
        id: deps.newRequestId(),
        type: "codeq.execute",
        command,
      },
    });

    if (response.type === "codeq.execute.result") {
      return response.envelope;
    }

    return codeIntelClientFailure({
      cwd: deps.cwd,
      code: "request_failed",
      message:
        response.type === "codeq.error"
          ? response.error.message
          : `Unexpected codeq host response: ${response.type}`,
      retryable: response.type === "codeq.error" && response.error.code === "CODEQ_ERROR",
    });
  } catch (error) {
    return codeIntelClientFailure({
      cwd: deps.cwd,
      code: classifyClientError(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: classifyClientError(error) !== "invalid_args",
    });
  }
}

function parseCodeIntelClientOptions(
  argv: string[],
  env: Record<string, string | undefined>,
): {
  commandArgv: string[];
  socketPath?: string;
  timeoutMs?: number;
} {
  const commandArgv: string[] = [];
  let socketPath = env.TAH_CODEQ_HOST_SOCKET;
  let timeoutMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--host-socket") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Usage: tiny-agent codeq <command> --host-socket <path> --json");
      }
      socketPath = value;
      index += 1;
      continue;
    }
    if (arg === "--host-timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Usage: tiny-agent codeq <command> --host-timeout-ms <ms> --json");
      }
      timeoutMs = parsePositiveInteger(value, "--host-timeout-ms");
      index += 1;
      continue;
    }
    commandArgv.push(arg);
  }

  return { commandArgv, socketPath, timeoutMs };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function codeIntelClientFailure(input: {
  cwd: string;
  code: CodeIntelErrorCode;
  message: string;
  retryable: boolean;
}): CodeIntelEnvelope {
  return failureEnvelope({
    cwd: input.cwd,
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
    },
  });
}

function classifyClientError(error: unknown): CodeIntelErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Usage:") || message.includes("<path>:<line>:<column>")) {
    return "invalid_args";
  }
  if (message.includes("Timed out")) {
    return "server_timeout";
  }
  if (
    message.includes("ENOENT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("not found")
  ) {
    return "server_not_found";
  }
  return "request_failed";
}
