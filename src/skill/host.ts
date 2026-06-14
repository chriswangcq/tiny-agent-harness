import {
  listenResidentHostSocket,
  requestResidentHostJson,
  residentHostProcessId,
} from "../runtime/resident-host.js";
import {
  defaultSkillCommandDeps,
  executeSkillHostCommand,
  type SkillCommandDeps,
} from "./command.js";

export type SkillHostExecuteRequest = {
  schemaVersion: 1;
  id: string;
  type: "skill.execute";
  argv: string[];
};

export type SkillHostShutdownRequest = {
  schemaVersion: 1;
  id: string;
  type: "skill.shutdown";
  reason?: string;
};

export type SkillHostRequest =
  | SkillHostExecuteRequest
  | SkillHostShutdownRequest;

export type SkillHostResponse =
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "skill.execute.result";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "skill.shutdown.result";
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: false;
      type: "skill.error";
      error: {
        code: "BAD_REQUEST" | "SKILL_ERROR";
        message: string;
      };
    };

export type SkillHostExecutor = {
  execute(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  dispose(): Promise<void>;
};

export function skillHostProcessId(runId: string): string {
  return residentHostProcessId("skill-host", runId);
}

export function createSkillHostExecutor(
  deps: SkillCommandDeps = defaultSkillCommandDeps(),
): SkillHostExecutor {
  return {
    async execute(argv) {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const exitCode = await executeSkillHostCommand(argv, {
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

export async function handleSkillHostRequest(
  executor: SkillHostExecutor,
  request: SkillHostRequest,
): Promise<SkillHostResponse> {
  if (request.type === "skill.shutdown") {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "skill.shutdown.result",
    };
  }

  try {
    const result = await executor.execute(request.argv);
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "skill.execute.result",
      ...result,
    };
  } catch (error) {
    return skillHostErrorResponse({
      id: request.id,
      code: "SKILL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseSkillHostRequest(raw: string): SkillHostRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid skill host request JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid skill host request: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid skill host request: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid skill host request: id must be non-empty");
  }
  if (parsed.type === "skill.shutdown") {
    return parsed as SkillHostShutdownRequest;
  }
  if (parsed.type !== "skill.execute") {
    throw new Error("Invalid skill host request: unsupported type");
  }
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((arg) => typeof arg === "string")) {
    throw new Error("Invalid skill execute request: argv must be string[]");
  }
  return parsed as SkillHostExecuteRequest;
}

export function parseSkillHostResponse(
  raw: string,
  expectedId?: string,
): SkillHostResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid skill host response JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid skill host response: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid skill host response: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid skill host response: id must be non-empty");
  }
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error(
      `Invalid skill host response: expected id ${expectedId}, got ${parsed.id}`,
    );
  }
  if (typeof parsed.ok !== "boolean" || typeof parsed.type !== "string") {
    throw new Error("Invalid skill host response: ok and type are required");
  }
  return parsed as SkillHostResponse;
}

export async function listenSkillHostSocket(options: {
  socketPath: string;
  executor: SkillHostExecutor;
}): Promise<{ close(): Promise<void>; closed: Promise<void> }> {
  const server = await listenResidentHostSocket({
    socketPath: options.socketPath,
    handleLine: async (line) => {
      let close = false;
      let response: SkillHostResponse;
      try {
        const request = parseSkillHostRequest(line);
        response = await handleSkillHostRequest(options.executor, request);
        close = request.type === "skill.shutdown";
      } catch (error) {
        response = skillHostErrorResponse({
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

export async function requestSkillHostSocket(options: {
  socketPath: string;
  request: SkillHostRequest;
  timeoutMs: number;
}): Promise<SkillHostResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) => parseSkillHostResponse(raw, options.request.id),
  });
}

export async function runSkillHostCli(argv: string[]): Promise<number> {
  const { socketPath } = parseHostOptions(argv);
  const executor = createSkillHostExecutor(defaultSkillCommandDeps());
  if (!socketPath) {
    throw new Error("Usage: tiny-agent skill host --socket <path>");
  }
  const server = await listenSkillHostSocket({ socketPath, executor });
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
      throw new Error(`Unknown or incomplete skill host option: ${arg}`);
    }
  }
  return { socketPath };
}

function skillHostErrorResponse(input: {
  id: string;
  code: "BAD_REQUEST" | "SKILL_ERROR";
  message: string;
}): SkillHostResponse {
  return {
    schemaVersion: 1,
    id: input.id,
    ok: false,
    type: "skill.error",
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
