import { randomUUID } from "node:crypto";
import { failureEnvelope } from "./envelope.js";
import { skillUsage } from "../skill/command.js";
import {
  requestSkillHostSocket,
  runSkillHostCli,
  type SkillHostExecuteRequest,
  type SkillHostResponse,
} from "../skill/host.js";

const DEFAULT_SKILL_HOST_TIMEOUT_MS = 30_000;

export type SkillClientRequest = {
  socketPath: string;
  request: SkillHostExecuteRequest;
  timeoutMs: number;
};

export type SkillCliDeps = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  cwd: string;
  timeoutMs: number;
  newRequestId: () => string;
  requestHost: (request: SkillClientRequest) => Promise<SkillHostResponse>;
};

export function defaultSkillCliDeps(): SkillCliDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: DEFAULT_SKILL_HOST_TIMEOUT_MS,
    newRequestId: () => `skill-cli-${randomUUID()}`,
    requestHost: requestSkillHostSocket,
  };
}

export async function runSkill(
  argv: string[],
  deps: SkillCliDeps = defaultSkillCliDeps(),
): Promise<number> {
  if (argv[0] === "host") {
    return await runSkillHostCli(argv.slice(1));
  }

  if (!argv[0] || argv[0] === "--help" || argv[0] === "-h") {
    deps.stdout.write(skillUsage());
    return 0;
  }

  return await executeSkillClientArgv(argv, deps);
}

export async function executeSkillClientArgv(
  argv: string[],
  deps: SkillCliDeps,
): Promise<number> {
  let options: ReturnType<typeof parseSkillClientOptions>;
  try {
    options = parseSkillClientOptions(argv, deps.env);
  } catch (error) {
    writeSkillClientFailure(
      deps,
      "SKILL_HOST_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }

  if (!options.socketPath) {
    writeSkillClientFailure(
      deps,
      "SKILL_HOST_NOT_FOUND",
      "tiny-agent skill requires a run-scoped Skill host socket. Set TAH_SKILL_HOST_SOCKET or pass --host-socket <path>.",
    );
    return 1;
  }

  try {
    const response = await deps.requestHost({
      socketPath: options.socketPath,
      timeoutMs: options.timeoutMs ?? deps.timeoutMs,
      request: {
        schemaVersion: 1,
        id: deps.newRequestId(),
        type: "skill.execute",
        argv: options.commandArgv,
      },
    });

    if (response.type === "skill.execute.result") {
      if (response.stdout) deps.stdout.write(response.stdout);
      if (response.stderr) deps.stderr.write(response.stderr);
      return response.exitCode;
    }

    const message =
      response.type === "skill.error"
        ? response.error.message
        : `Unexpected skill host response: ${response.type}`;
    writeSkillClientFailure(deps, "SKILL_HOST_ERROR", message);
    return 1;
  } catch (error) {
    writeSkillClientFailure(
      deps,
      "SKILL_HOST_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}

function parseSkillClientOptions(
  argv: string[],
  env: Record<string, string | undefined>,
): {
  commandArgv: string[];
  socketPath?: string;
  timeoutMs?: number;
} {
  const commandArgv: string[] = [];
  let socketPath = env.TAH_SKILL_HOST_SOCKET;
  let timeoutMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--host-socket") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Usage: tiny-agent skill <command> --host-socket <path>");
      }
      socketPath = value;
      index += 1;
      continue;
    }
    if (arg === "--host-timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Usage: tiny-agent skill <command> --host-timeout-ms <ms>");
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

function writeSkillClientFailure(
  deps: Pick<SkillCliDeps, "stdout">,
  errorCode: string,
  error: string,
): void {
  deps.stdout.write(
    JSON.stringify(
      failureEnvelope({
        tool: "skill",
        errorCode,
        error,
      }),
    ) + "\n",
  );
}
