import {
  listenResidentHostSocket,
  requestResidentHostJson,
  residentHostProcessId,
} from "../runtime/resident-host.js";
import {
  defaultMcpCommandDeps,
  executeMcpHostCommand,
  type McpCommandDeps,
} from "./cli.js";

export type McpHostExecuteRequest = {
  schemaVersion: 1;
  id: string;
  type: "mcp.execute";
  argv: string[];
};

export type McpHostShutdownRequest = {
  schemaVersion: 1;
  id: string;
  type: "mcp.shutdown";
  reason?: string;
};

export type McpHostRequest =
  | McpHostExecuteRequest
  | McpHostShutdownRequest;

export type McpHostResponse =
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "mcp.execute.result";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "mcp.shutdown.result";
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: false;
      type: "mcp.error";
      error: {
        code: "BAD_REQUEST" | "MCP_ERROR";
        message: string;
      };
    };

export type McpHostExecutor = {
  execute(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  dispose(): Promise<void>;
};

export function mcpHostProcessId(runId: string): string {
  return residentHostProcessId("mcp-host", runId);
}

export function createMcpHostExecutor(
  deps: McpCommandDeps = defaultMcpCommandDeps(),
): McpHostExecutor {
  return {
    async execute(argv) {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const exitCode = await executeMcpHostCommand(argv, {
        ...deps,
        stdout: {
          write(text: string) {
            stdoutChunks.push(text);
            return undefined;
          },
        },
        stderr: {
          write(text: string) {
            stderrChunks.push(text);
            return undefined;
          },
        },
      });
      return {
        exitCode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      };
    },
    async dispose() {},
  };
}

export async function handleMcpHostRequest(
  executor: McpHostExecutor,
  request: McpHostRequest,
): Promise<McpHostResponse> {
  if (request.type === "mcp.shutdown") {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "mcp.shutdown.result",
    };
  }

  try {
    const result = await executor.execute(request.argv);
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "mcp.execute.result",
      ...result,
    };
  } catch (error) {
    return mcpHostErrorResponse({
      id: request.id,
      code: "MCP_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseMcpHostRequest(raw: string): McpHostRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid MCP host request JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid MCP host request: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid MCP host request: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid MCP host request: id must be non-empty");
  }
  if (parsed.type === "mcp.shutdown") {
    return parsed as McpHostShutdownRequest;
  }
  if (parsed.type !== "mcp.execute") {
    throw new Error("Invalid MCP host request: unsupported type");
  }
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((arg) => typeof arg === "string")) {
    throw new Error("Invalid MCP execute request: argv must be string[]");
  }
  return parsed as McpHostExecuteRequest;
}

export function parseMcpHostResponse(
  raw: string,
  expectedId?: string,
): McpHostResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid MCP host response JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid MCP host response: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid MCP host response: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid MCP host response: id must be non-empty");
  }
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error(
      `Invalid MCP host response: expected id ${expectedId}, got ${parsed.id}`,
    );
  }
  if (typeof parsed.ok !== "boolean" || typeof parsed.type !== "string") {
    throw new Error("Invalid MCP host response: ok and type are required");
  }
  return parsed as McpHostResponse;
}

export async function listenMcpHostSocket(options: {
  socketPath: string;
  executor: McpHostExecutor;
}): Promise<{ close(): Promise<void>; closed: Promise<void> }> {
  const server = await listenResidentHostSocket({
    socketPath: options.socketPath,
    handleLine: async (line) => {
      let close = false;
      let response: McpHostResponse;
      try {
        const request = parseMcpHostRequest(line);
        response = await handleMcpHostRequest(options.executor, request);
        close = request.type === "mcp.shutdown";
      } catch (error) {
        response = mcpHostErrorResponse({
          id: "unknown",
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (close) {
        await options.executor.dispose();
      }
      return {
        responseLine: JSON.stringify(response),
        close,
      };
    },
  });
  let isClosed = false;
  const closed = new Promise<void>((resolve) => {
    server.once("close", () => {
      isClosed = true;
      resolve();
    });
  });

  return {
    closed,
    close: async () => {
      if (isClosed) return;
      await options.executor.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function requestMcpHostSocket(options: {
  socketPath: string;
  request: McpHostRequest;
  timeoutMs: number;
}): Promise<McpHostResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) => parseMcpHostResponse(raw, options.request.id),
  });
}

export async function runMcpHostCli(argv: string[]): Promise<number> {
  const { socketPath } = parseHostOptions(argv);
  const executor = createMcpHostExecutor(defaultMcpCommandDeps());
  if (!socketPath) {
    throw new Error("Usage: tiny-agent mcp host --socket <path>");
  }
  const server = await listenMcpHostSocket({ socketPath, executor });
  await Promise.race([server.closed, new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  })]);
  await server.close();
  return 0;
}

function parseHostOptions(argv: string[]): { socketPath?: string } {
  let socketPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = argv[index + 1];
    if (arg === "--socket" && value) {
      socketPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete MCP host option: ${arg}`);
    }
  }
  return { socketPath };
}

function mcpHostErrorResponse(input: {
  id: string;
  code: "BAD_REQUEST" | "MCP_ERROR";
  message: string;
}): McpHostResponse {
  return {
    schemaVersion: 1,
    id: input.id,
    ok: false,
    type: "mcp.error",
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
