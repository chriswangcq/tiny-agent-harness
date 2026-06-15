import type { ModelPort } from "../run/orchestrator.js";
import type {
  FimStepOutput,
  ModelStepContext,
  ToolDefinition,
} from "../types/index.js";

export type ModelGatewayGenerateRequest = {
  schemaVersion: 1;
  id: string;
  type: "model.generateTurn";
  context: ModelStepContext;
  tools: ToolDefinition[];
};

export type ModelGatewayShutdownRequest = {
  schemaVersion: 1;
  id: string;
  type: "model.shutdown";
  reason?: string;
};

export type ModelGatewayRequest =
  | ModelGatewayGenerateRequest
  | ModelGatewayShutdownRequest;

export type ModelGatewayResponse =
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "model.generateTurn.result";
      output: FimStepOutput;
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "model.shutdown.result";
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: false;
      type: "model.error";
      error: {
        code: "BAD_REQUEST" | "MODEL_ERROR" | "CANCELLED";
        message: string;
      };
    };

export interface ModelGatewayTransportPort {
  request(request: ModelGatewayRequest): Promise<ModelGatewayResponse>;
}

export type ModelGatewayPortDeps = {
  transport: ModelGatewayTransportPort;
  newRequestId: () => string;
};

export function createModelGatewayPort(deps: ModelGatewayPortDeps): ModelPort {
  return {
    async generateTurn(context, options) {
      const response = await deps.transport.request({
        schemaVersion: 1,
        id: deps.newRequestId(),
        type: "model.generateTurn",
        context,
        tools: options.tools,
      });
      if (!response.ok) {
        throw new Error(
          `Model gateway request failed: ${response.error.code}: ${response.error.message}`,
        );
      }
      if (response.type !== "model.generateTurn.result") {
        throw new Error(
          `Model gateway returned unexpected response type: ${response.type}`,
        );
      }
      return response.output;
    },
  };
}

export function serializeModelGatewayRequest(
  request: ModelGatewayRequest,
): string {
  return `${JSON.stringify(request)}\n`;
}

export function serializeModelGatewayResponse(
  response: ModelGatewayResponse,
): string {
  return `${JSON.stringify(response)}\n`;
}

export function parseModelGatewayRequest(raw: string): ModelGatewayRequest {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Invalid model gateway request: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid model gateway request: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid model gateway request: id must be non-empty");
  }
  if (parsed.type === "model.shutdown") {
    return parsed as ModelGatewayShutdownRequest;
  }
  if (parsed.type !== "model.generateTurn") {
    throw new Error("Invalid model gateway request: unsupported type");
  }
  if (!isRecord(parsed.context) || !Array.isArray(parsed.tools)) {
    throw new Error(
      "Invalid model generate request: context object and tools array are required",
    );
  }
  return parsed as ModelGatewayGenerateRequest;
}

export function parseModelGatewayResponse(
  raw: string,
  expectedId?: string,
): ModelGatewayResponse {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Invalid model gateway response: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid model gateway response: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid model gateway response: id must be non-empty");
  }
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error(
      `Invalid model gateway response: expected id ${expectedId}, got ${parsed.id}`,
    );
  }
  if (typeof parsed.ok !== "boolean") {
    throw new Error("Invalid model gateway response: ok must be boolean");
  }
  if (parsed.ok === false) {
    if (parsed.type !== "model.error") {
      throw new Error("Invalid model gateway error response: type must be model.error");
    }
    if (!isRecord(parsed.error)) {
      throw new Error("Invalid model gateway error response: error must be object");
    }
    if (typeof parsed.error.message !== "string") {
      throw new Error("Invalid model gateway error response: error.message must be string");
    }
    if (
      parsed.error.code !== "BAD_REQUEST" &&
      parsed.error.code !== "MODEL_ERROR" &&
      parsed.error.code !== "CANCELLED"
    ) {
      throw new Error("Invalid model gateway error response: unsupported error.code");
    }
    return parsed as Extract<ModelGatewayResponse, { ok: false }>;
  }
  if (
    parsed.type !== "model.generateTurn.result" &&
    parsed.type !== "model.shutdown.result"
  ) {
    throw new Error("Invalid model gateway success response: unsupported type");
  }
  if (parsed.type === "model.generateTurn.result" && !isRecord(parsed.output)) {
    throw new Error("Invalid model generate response: output must be object");
  }
  return parsed as Extract<ModelGatewayResponse, { ok: true }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
