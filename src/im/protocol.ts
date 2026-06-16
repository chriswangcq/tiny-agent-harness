import * as crypto from "node:crypto";
import {
  PublicImService,
  type PublicImMessageKind,
  type PublicImPairKind,
} from "./service.js";
import { createNodeImStore } from "./store.js";

export type RuntimeImContext = {
  stateRoot: string;
};

export type RuntimeImPairRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.pair";
  a: string;
  b: string;
  kind?: PublicImPairKind | string;
};

export type RuntimeImBindRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.bind";
  runId: string;
  self: string;
  peer: string;
  kind?: PublicImPairKind | string;
};

export type RuntimeImPostRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.post";
  from: string;
  to: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeImSendRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.send";
  from: string;
  to: string;
  kind: Exclude<PublicImMessageKind, "message">;
  text: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeImRecvRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.recv";
  as: string;
  with: string;
  cursor?: string;
  consumer?: string;
};

export type RuntimeImAckRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.ack";
  as: string;
  with: string;
  messageId: string;
};

export type RuntimeImRunRecvRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.run-recv";
  runId: string;
};

export type RuntimeImRunAckRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.run-ack";
  runId: string;
  peer: string;
  messageId: string;
};

export type RuntimeImRequest =
  | RuntimeImPairRequest
  | RuntimeImBindRequest
  | RuntimeImPostRequest
  | RuntimeImSendRequest
  | RuntimeImRecvRequest
  | RuntimeImAckRequest
  | RuntimeImRunRecvRequest
  | RuntimeImRunAckRequest;

export type RuntimeImResponse =
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "im.result";
      command: RuntimeImRequest["type"];
      data: unknown;
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: false;
      type: "im.error";
      error: {
        code: "BAD_REQUEST" | "IM_ERROR";
        message: string;
      };
    };

export function createDefaultRuntimeImService(): PublicImService {
  return new PublicImService({
    store: createNodeImStore(),
    clock: { nowIso: () => new Date().toISOString() },
    ids: {
      newMessageId: (seed) => {
        const scope = seed.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
        return `im-${scope}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
      },
    },
  });
}

export async function handleRuntimeImRequest(
  service: PublicImService,
  context: RuntimeImContext,
  request: RuntimeImRequest,
): Promise<RuntimeImResponse> {
  try {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "im.result",
      command: request.type,
      data: await executeRuntimeImRequest(service, context, request),
    };
  } catch (error) {
    return runtimeImErrorResponse({
      id: request.id,
      code: "IM_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseRuntimeImRequest(raw: string): RuntimeImRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid runtime IM request JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid runtime IM request: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid runtime IM request: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid runtime IM request: id must be non-empty");
  }
  if (typeof parsed.type !== "string") {
    throw new Error("Invalid runtime IM request: type must be string");
  }

  switch (parsed.type) {
    case "im.pair":
      requireStringField(parsed, "a", parsed.type);
      requireStringField(parsed, "b", parsed.type);
      optionalStringField(parsed, "kind", parsed.type);
      break;
    case "im.bind":
      requireStringField(parsed, "runId", parsed.type);
      requireStringField(parsed, "self", parsed.type);
      requireStringField(parsed, "peer", parsed.type);
      optionalStringField(parsed, "kind", parsed.type);
      break;
    case "im.post":
      requireStringField(parsed, "from", parsed.type);
      requireStringField(parsed, "to", parsed.type);
      requireStringField(parsed, "text", parsed.type);
      optionalMetadataField(parsed, parsed.type);
      break;
    case "im.send":
      requireStringField(parsed, "from", parsed.type);
      requireStringField(parsed, "to", parsed.type);
      requireStringField(parsed, "text", parsed.type);
      if (parsed.kind !== "status" && parsed.kind !== "error") {
        throw new Error("Invalid im.send request: kind must be status or error");
      }
      optionalMetadataField(parsed, parsed.type);
      break;
    case "im.recv":
      requireStringField(parsed, "as", parsed.type);
      requireStringField(parsed, "with", parsed.type);
      optionalStringField(parsed, "cursor", parsed.type);
      optionalStringField(parsed, "consumer", parsed.type);
      break;
    case "im.ack":
      requireStringField(parsed, "as", parsed.type);
      requireStringField(parsed, "with", parsed.type);
      requireStringField(parsed, "messageId", parsed.type);
      break;
    case "im.run-recv":
      requireStringField(parsed, "runId", parsed.type);
      break;
    case "im.run-ack":
      requireStringField(parsed, "runId", parsed.type);
      requireStringField(parsed, "peer", parsed.type);
      requireStringField(parsed, "messageId", parsed.type);
      break;
    default:
      throw new Error(`Invalid runtime IM request: unsupported type ${parsed.type}`);
  }

  return parsed as RuntimeImRequest;
}

export function parseRuntimeImResponse(
  raw: string,
  expectedId?: string,
): RuntimeImResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid runtime IM response JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid runtime IM response: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid runtime IM response: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid runtime IM response: id must be non-empty");
  }
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error(
      `Invalid runtime IM response: expected id ${expectedId}, got ${parsed.id}`,
    );
  }
  if (typeof parsed.ok !== "boolean" || typeof parsed.type !== "string") {
    throw new Error("Invalid runtime IM response: ok and type are required");
  }
  return parsed as RuntimeImResponse;
}

function executeRuntimeImRequest(
  service: PublicImService,
  context: RuntimeImContext,
  request: RuntimeImRequest,
): Promise<unknown> {
  switch (request.type) {
    case "im.pair":
      return service.createPair({
        stateRoot: context.stateRoot,
        a: request.a,
        b: request.b,
        kind: request.kind,
      }).then((pair) => ({ pair, stateRoot: context.stateRoot }));
    case "im.bind":
      return service.bindRun({
        stateRoot: context.stateRoot,
        runId: request.runId,
        self: request.self,
        peer: request.peer,
        kind: request.kind ?? "a2user",
      }).then((binding) => ({ binding, stateRoot: context.stateRoot }));
    case "im.post":
      return service.postMessage({
        stateRoot: context.stateRoot,
        from: request.from,
        to: request.to,
        text: request.text,
        metadata: request.metadata ?? { source: "runtime-replica" },
      }).then((message) => ({
        message,
        id: message.id,
        from: message.from,
        to: message.to,
      }));
    case "im.send":
      return service.sendMessage({
        stateRoot: context.stateRoot,
        from: request.from,
        to: request.to,
        kind: request.kind,
        text: request.text,
        metadata: request.metadata ?? { source: "runtime-replica" },
      }).then((message) => ({
        message,
        id: message.id,
        from: message.from,
        to: message.to,
        kind: request.kind,
      }));
    case "im.recv":
      return service.receiveForPair({
        stateRoot: context.stateRoot,
        as: request.as,
        with: request.with,
        cursor: request.cursor,
        consumer: request.consumer,
      }).then((result) => ({
        as: request.as,
        with: request.with,
        count: result.messages.length,
        nextCursor: result.nextCursor,
        messages: result.messages,
        cursorFound: result.cursorFound,
      }));
    case "im.ack":
      return service.ackPair({
        stateRoot: context.stateRoot,
        as: request.as,
        with: request.with,
        messageId: request.messageId,
      }).then(() => ({
        as: request.as,
        with: request.with,
        messageId: request.messageId,
      }));
    case "im.run-recv":
      return service.receiveForRun({
        stateRoot: context.stateRoot,
        runId: request.runId,
      }).then((result) => ({
        runId: result.runId,
        self: result.self,
        count: result.messages.length,
        nextCursors: result.nextCursors,
        messages: result.messages,
      }));
    case "im.run-ack":
      return service.ackRunChannel({
        stateRoot: context.stateRoot,
        runId: request.runId,
        peer: request.peer,
        messageId: request.messageId,
      }).then(() => ({
        runId: request.runId,
        peer: request.peer,
        messageId: request.messageId,
      }));
  }
}

export function runtimeImErrorResponse(input: {
  id: string;
  code: "BAD_REQUEST" | "IM_ERROR";
  message: string;
}): RuntimeImResponse {
  return {
    schemaVersion: 1,
    id: input.id,
    ok: false,
    type: "im.error",
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

function requireStringField(
  record: Record<string, unknown>,
  key: string,
  type: string,
): void {
  if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
    throw new Error(`Invalid ${type} request: ${key} must be non-empty string`);
  }
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
  type: string,
): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    throw new Error(`Invalid ${type} request: ${key} must be string`);
  }
}

function optionalMetadataField(record: Record<string, unknown>, type: string): void {
  if (record.metadata !== undefined && !isRecord(record.metadata)) {
    throw new Error(`Invalid ${type} request: metadata must be object`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
