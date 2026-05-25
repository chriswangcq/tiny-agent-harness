import type {
  BackendInfo,
  CodeIntelEnvelope,
  CodeIntelError,
  CodeIntelFailure,
  CodeIntelLimits,
  CodeIntelQuery,
  CodeIntelSuccess,
} from "./types.js";

export const CODEQ_VERSION = "0.1.0";

export function successEnvelope<T>(input: {
  cwd: string;
  workspaceRoot: string;
  configPath?: string;
  backend?: BackendInfo;
  query: CodeIntelQuery;
  result: T;
  limits: CodeIntelLimits;
  warnings?: string[];
}): CodeIntelSuccess<T> {
  return {
    ok: true,
    tool: "codeq",
    version: CODEQ_VERSION,
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    configPath: input.configPath,
    backend: input.backend,
    query: input.query,
    result: input.result,
    limits: input.limits,
    warnings: input.warnings,
  };
}

export function failureEnvelope(input: {
  cwd: string;
  workspaceRoot?: string;
  configPath?: string;
  error: CodeIntelError;
}): CodeIntelFailure {
  return {
    ok: false,
    tool: "codeq",
    version: CODEQ_VERSION,
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    configPath: input.configPath,
    error: input.error,
  };
}

export function asJson(envelope: CodeIntelEnvelope): string {
  return `${JSON.stringify(stripUndefined(envelope), null, 2)}\n`;
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as T;
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined) {
        output[key] = stripUndefined(nested);
      }
    }
    return output as T;
  }

  return value;
}
