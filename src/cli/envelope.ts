// Shared JSON envelope helpers for capability CLI commands.
// Lightweight convention: every JSON line on stdout is a success or failure envelope.

export const CAPABILITY_VERSIONS: Record<string, string> = {
  im: "0.1.0",
  skill: "0.1.0",
  mcp: "0.1.0",
  codeq: "0.1.0",
};

export interface CliSuccessEnvelope<T = unknown> {
  ok: true;
  tool: string;
  version: string;
  cwd?: string;
  [key: string]: unknown;
  result?: T;
}

export interface CliFailureEnvelope {
  ok: false;
  tool: string;
  version: string;
  cwd?: string;
  errorCode: string;
  error: string;
  details?: unknown;
}

export type CliEnvelope<T = unknown> = CliSuccessEnvelope<T> | CliFailureEnvelope;

export interface SuccessEnvelopeInput {
  tool: string;
  cwd?: string;
  extra?: Record<string, unknown>;
}

export interface FailureEnvelopeInput {
  tool: string;
  cwd?: string;
  errorCode: string;
  error: string;
  details?: unknown;
}

export function successEnvelope<T = unknown>(
  input: SuccessEnvelopeInput,
): CliSuccessEnvelope<T> {
  return {
    ok: true,
    tool: input.tool,
    version: CAPABILITY_VERSIONS[input.tool] ?? "0.1.0",
    cwd: input.cwd,
    ...(input.extra ?? {}),
  };
}

export function failureEnvelope(input: FailureEnvelopeInput): CliFailureEnvelope {
  return {
    ok: false,
    tool: input.tool,
    version: CAPABILITY_VERSIONS[input.tool] ?? "0.1.0",
    cwd: input.cwd,
    errorCode: input.errorCode,
    error: input.error,
    details: input.details,
  };
}
