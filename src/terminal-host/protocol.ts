import type { ToolObservation, ToolRequest } from "../types/tools.js";

export type TerminalHostExecuteRequest = {
  schemaVersion: 1;
  id: string;
  type: "terminal.execute";
  request: ToolRequest;
};

export type TerminalHostShutdownRequest = {
  schemaVersion: 1;
  id: string;
  type: "terminal.shutdown";
  reason?: string;
};

export type TerminalHostRequest =
  | TerminalHostExecuteRequest
  | TerminalHostShutdownRequest;

export type TerminalHostSuccessResponse =
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "terminal.execute.result";
      observation: ToolObservation;
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "terminal.shutdown.result";
    };

export type TerminalHostErrorResponse = {
  schemaVersion: 1;
  id: string;
  ok: false;
  type: "terminal.error";
  error: {
    message: string;
    code: "BAD_REQUEST" | "TERMINAL_ERROR";
  };
};

export type TerminalHostResponse =
  | TerminalHostSuccessResponse
  | TerminalHostErrorResponse;

export function parseTerminalHostRequest(raw: string): TerminalHostRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid terminal host request JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertTerminalHostRequest(parsed);
}

export function serializeTerminalHostResponse(
  response: TerminalHostResponse,
): string {
  return `${JSON.stringify(response)}\n`;
}

export function terminalHostErrorResponse(input: {
  id?: string;
  message: string;
  code?: TerminalHostErrorResponse["error"]["code"];
}): TerminalHostErrorResponse {
  return {
    schemaVersion: 1,
    id: input.id ?? "unknown",
    ok: false,
    type: "terminal.error",
    error: {
      message: input.message,
      code: input.code ?? "TERMINAL_ERROR",
    },
  };
}

function assertTerminalHostRequest(value: unknown): TerminalHostRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid terminal host request: expected object");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Invalid terminal host request: schemaVersion must be 1");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Invalid terminal host request: id must be non-empty");
  }
  if (value.type === "terminal.shutdown") {
    if (value.reason !== undefined && typeof value.reason !== "string") {
      throw new Error("Invalid terminal shutdown request: reason must be string");
    }
    return value as TerminalHostShutdownRequest;
  }
  if (value.type !== "terminal.execute") {
    throw new Error("Invalid terminal host request: unsupported type");
  }
  if (!isRecord(value.request) || value.request.kind !== "terminal_tool") {
    throw new Error(
      "Invalid terminal execute request: request.kind must be terminal_tool",
    );
  }
  return value as TerminalHostExecuteRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
