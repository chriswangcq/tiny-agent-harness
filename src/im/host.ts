import * as crypto from "node:crypto";
import {
  listenResidentHostSocket,
  requestResidentHostJson,
} from "../runtime/resident-host.js";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  createRunImSelfEndpoint,
} from "./run-endpoints.js";
import {
  PublicImService,
  type PublicImMessageKind,
  type PublicImPairKind,
} from "./service.js";
import { createNodeImStore } from "./store.js";

export type ImHostContext = {
  stateRoot: string;
  runId?: string;
  selfEndpoint?: string;
  userEndpoint?: string;
};

export type ImHostPairRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.pair";
  a: string;
  b: string;
  kind?: PublicImPairKind | string;
};

export type ImHostBindRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.bind";
  runId?: string;
  self?: string;
  peer?: string;
  kind?: PublicImPairKind | string;
};

export type ImHostPostRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.post";
  from?: string;
  to?: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type ImHostSendRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.send";
  from?: string;
  to?: string;
  kind: Exclude<PublicImMessageKind, "message">;
  text: string;
  metadata?: Record<string, unknown>;
};

export type ImHostRecvRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.recv";
  as?: string;
  with?: string;
  cursor?: string;
};

export type ImHostAckRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.ack";
  as?: string;
  with?: string;
  messageId: string;
};

export type ImHostRunRecvRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.run-recv";
  runId?: string;
};

export type ImHostRunAckRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.run-ack";
  runId?: string;
  peer?: string;
  messageId: string;
};

export type ImHostShutdownRequest = {
  schemaVersion: 1;
  id: string;
  type: "im.shutdown";
  reason?: string;
};

export type ImHostRequest =
  | ImHostPairRequest
  | ImHostBindRequest
  | ImHostPostRequest
  | ImHostSendRequest
  | ImHostRecvRequest
  | ImHostAckRequest
  | ImHostRunRecvRequest
  | ImHostRunAckRequest
  | ImHostShutdownRequest;

export type ImHostResponse =
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "im.result";
      command: Exclude<ImHostRequest["type"], "im.shutdown">;
      data: unknown;
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "im.shutdown.result";
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

export type ImHostRequestHandler = (
  request: ImHostRequest,
) => Promise<ImHostResponse>;

export function createDefaultImHostService(): PublicImService {
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

export async function handleImHostRequest(
  service: PublicImService,
  context: ImHostContext,
  request: ImHostRequest,
): Promise<ImHostResponse> {
  if (request.type === "im.shutdown") {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "im.shutdown.result",
    };
  }

  try {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "im.result",
      command: request.type,
      data: await executeImHostRequest(service, context, request),
    };
  } catch (error) {
    return imHostErrorResponse({
      id: request.id,
      code: "IM_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseImHostRequest(raw: string): ImHostRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid IM host request JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid IM host request: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid IM host request: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid IM host request: id must be non-empty");
  }
  if (typeof parsed.type !== "string") {
    throw new Error("Invalid IM host request: type must be string");
  }

  switch (parsed.type) {
    case "im.pair":
      requireStringField(parsed, "a", parsed.type);
      requireStringField(parsed, "b", parsed.type);
      optionalStringField(parsed, "kind", parsed.type);
      break;
    case "im.bind":
      optionalStringField(parsed, "runId", parsed.type);
      optionalStringField(parsed, "self", parsed.type);
      optionalStringField(parsed, "peer", parsed.type);
      optionalStringField(parsed, "kind", parsed.type);
      break;
    case "im.post":
      optionalStringField(parsed, "from", parsed.type);
      optionalStringField(parsed, "to", parsed.type);
      requireStringField(parsed, "text", parsed.type);
      optionalMetadataField(parsed, parsed.type);
      break;
    case "im.send":
      optionalStringField(parsed, "from", parsed.type);
      optionalStringField(parsed, "to", parsed.type);
      requireStringField(parsed, "text", parsed.type);
      if (parsed.kind !== "status" && parsed.kind !== "error") {
        throw new Error("Invalid im.send request: kind must be status or error");
      }
      optionalMetadataField(parsed, parsed.type);
      break;
    case "im.recv":
      optionalStringField(parsed, "as", parsed.type);
      optionalStringField(parsed, "with", parsed.type);
      optionalStringField(parsed, "cursor", parsed.type);
      break;
    case "im.ack":
      optionalStringField(parsed, "as", parsed.type);
      optionalStringField(parsed, "with", parsed.type);
      requireStringField(parsed, "messageId", parsed.type);
      break;
    case "im.run-recv":
      optionalStringField(parsed, "runId", parsed.type);
      break;
    case "im.run-ack":
      optionalStringField(parsed, "runId", parsed.type);
      optionalStringField(parsed, "peer", parsed.type);
      requireStringField(parsed, "messageId", parsed.type);
      break;
    case "im.shutdown":
      optionalStringField(parsed, "reason", parsed.type);
      break;
    default:
      throw new Error(`Invalid IM host request: unsupported type ${parsed.type}`);
  }

  return parsed as ImHostRequest;
}

export function parseImHostResponse(
  raw: string,
  expectedId?: string,
): ImHostResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid IM host response JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid IM host response: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid IM host response: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid IM host response: id must be non-empty");
  }
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error(
      `Invalid IM host response: expected id ${expectedId}, got ${parsed.id}`,
    );
  }
  if (typeof parsed.ok !== "boolean" || typeof parsed.type !== "string") {
    throw new Error("Invalid IM host response: ok and type are required");
  }
  return parsed as ImHostResponse;
}

export async function listenImHostSocket(options: {
  socketPath: string;
  service: PublicImService;
  context: ImHostContext;
  onShutdown?: () => Promise<void> | void;
}) {
  return await listenResidentHostSocket({
    socketPath: options.socketPath,
    handleLine: async (line) => {
      const { request, response } = await handleImHostSocketLine({
        line,
        handleRequest: async (request) =>
          handleImHostRequest(options.service, options.context, request),
      });
      if (request?.type === "im.shutdown") {
        await options.onShutdown?.();
      }
      return {
        responseLine: JSON.stringify(response),
        close: request?.type === "im.shutdown",
      };
    },
  });
}

export async function requestImHostSocket(options: {
  socketPath: string;
  request: ImHostRequest;
  timeoutMs: number;
}): Promise<ImHostResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) => parseImHostResponse(raw, options.request.id),
  });
}

export async function runImHostCli(argv: string[]): Promise<number> {
  const options = parseImHostCliOptions(argv);
  if (!options.socketPath || !options.stateRoot) {
    throw new Error("Usage: tiny-agent im host --socket <path> --state-dir <dir>");
  }
  const service = createDefaultImHostService();
  const server = await listenImHostSocket({
    socketPath: options.socketPath,
    service,
    context: {
      stateRoot: options.stateRoot,
      runId: options.runId,
      selfEndpoint: options.selfEndpoint,
      userEndpoint: options.userEndpoint,
    },
  });
  await Promise.race([
    new Promise<void>((resolve) => server.once("close", resolve)),
    new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    }),
  ]);
  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return 0;
}

async function executeImHostRequest(
  service: PublicImService,
  context: ImHostContext,
  request: Exclude<ImHostRequest, ImHostShutdownRequest>,
): Promise<unknown> {
  switch (request.type) {
    case "im.pair": {
      const pair = await service.createPair({
        stateRoot: context.stateRoot,
        a: request.a,
        b: request.b,
        kind: request.kind,
      });
      return { pair, stateRoot: context.stateRoot };
    }
    case "im.bind": {
      const runId = resolveRunId(context, request.runId);
      const self = resolveSelfEndpoint(context, request.self, runId);
      const peer = resolveUserEndpoint(context, request.peer);
      const binding = await service.bindRun({
        stateRoot: context.stateRoot,
        runId,
        self,
        peer,
        kind: request.kind ?? "a2user",
      });
      return { binding, stateRoot: context.stateRoot };
    }
    case "im.post": {
      const message = await service.postMessage({
        stateRoot: context.stateRoot,
        from: resolveUserEndpoint(context, request.from),
        to: resolveSelfEndpoint(context, request.to),
        text: request.text,
        metadata: request.metadata ?? { source: "im-host" },
      });
      return {
        message,
        id: message.id,
        from: message.from,
        to: message.to,
      };
    }
    case "im.send": {
      const message = await service.sendMessage({
        stateRoot: context.stateRoot,
        from: resolveSelfEndpoint(context, request.from),
        to: resolveUserEndpoint(context, request.to),
        kind: request.kind,
        text: request.text,
        metadata: request.metadata ?? { source: "im-host" },
      });
      return {
        message,
        id: message.id,
        from: message.from,
        to: message.to,
        kind: request.kind,
      };
    }
    case "im.recv": {
      const as = resolveSelfEndpoint(context, request.as);
      const withEndpoint = resolveUserEndpoint(context, request.with);
      const result = await service.receiveForPair({
        stateRoot: context.stateRoot,
        as,
        with: withEndpoint,
        cursor: request.cursor,
      });
      return {
        as,
        with: withEndpoint,
        count: result.messages.length,
        nextCursor: result.nextCursor,
        messages: result.messages,
        cursorFound: result.cursorFound,
      };
    }
    case "im.ack": {
      const as = resolveSelfEndpoint(context, request.as);
      const withEndpoint = resolveUserEndpoint(context, request.with);
      await service.ackPair({
        stateRoot: context.stateRoot,
        as,
        with: withEndpoint,
        messageId: request.messageId,
      });
      return { as, with: withEndpoint, messageId: request.messageId };
    }
    case "im.run-recv": {
      const runId = resolveRunId(context, request.runId);
      const result = await service.receiveForRun({
        stateRoot: context.stateRoot,
        runId,
      });
      return {
        runId: result.runId,
        self: result.self,
        count: result.messages.length,
        nextCursors: result.nextCursors,
        messages: result.messages,
      };
    }
    case "im.run-ack": {
      const runId = resolveRunId(context, request.runId);
      const peer = resolveUserEndpoint(context, request.peer);
      await service.ackRunChannel({
        stateRoot: context.stateRoot,
        runId,
        peer,
        messageId: request.messageId,
      });
      return { runId, peer, messageId: request.messageId };
    }
  }
}

async function handleImHostSocketLine(
  options: {
    line: string;
    handleRequest: ImHostRequestHandler;
  },
): Promise<{
  request?: ImHostRequest;
  response: ImHostResponse;
}> {
  let request: ImHostRequest;
  try {
    request = parseImHostRequest(options.line);
  } catch (error) {
    return {
      response: imHostErrorResponse({
        id: "unknown",
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  const response = await options.handleRequest(request);
  return { request, response };
}

function resolveRunId(context: ImHostContext, explicit?: string): string {
  return requireValue(explicit ?? context.runId, "runId");
}

function resolveSelfEndpoint(
  context: ImHostContext,
  explicit?: string,
  runId = context.runId,
): string {
  return explicit ?? context.selfEndpoint ?? (runId ? createRunImSelfEndpoint(runId) : requireValue(undefined, "self endpoint"));
}

function resolveUserEndpoint(context: ImHostContext, explicit?: string): string {
  return explicit ?? context.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value || value.length === 0) {
    throw new Error(`IM host missing required ${label}`);
  }
  return value;
}

function parseImHostCliOptions(argv: string[]): {
  socketPath?: string;
  stateRoot?: string;
  runId?: string;
  selfEndpoint?: string;
  userEndpoint?: string;
} {
  const options: {
    socketPath?: string;
    stateRoot?: string;
    runId?: string;
    selfEndpoint?: string;
    userEndpoint?: string;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = argv[index + 1];
    if (arg === "--socket" && value) {
      options.socketPath = value;
      index += 1;
    } else if (arg === "--state-dir" && value) {
      options.stateRoot = value;
      index += 1;
    } else if (arg === "--run-id" && value) {
      options.runId = value;
      index += 1;
    } else if (arg === "--self" && value) {
      options.selfEndpoint = value;
      index += 1;
    } else if (arg === "--user" && value) {
      options.userEndpoint = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete IM host option: ${arg}`);
    }
  }
  return options;
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

function imHostErrorResponse(input: {
  id: string;
  code: "BAD_REQUEST" | "IM_ERROR";
  message: string;
}): ImHostResponse {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
