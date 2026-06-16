import { randomUUID } from "node:crypto";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  createRunImSelfEndpoint,
  type RuntimeImRequest,
  type RuntimeImResponse,
  type PublicImRunBindingRecord,
  type PublicImRunReceiveMessage,
  type PublicImRunReceiveResult,
} from "../im/index.js";
import { requestRuntimeReplicaIm } from "../runtime/runtime-replica.js";

export { DEFAULT_RUN_USER_ENDPOINT, createRunImSelfEndpoint };

const DEFAULT_RUN_IM_TIMEOUT_MS = 30_000;

export type RunImRuntimeRequest = {
  socketPath: string;
  request: RuntimeImRequest;
  timeoutMs: number;
};

export type RunImRuntimeRequestPort = (
  request: RunImRuntimeRequest,
) => Promise<RuntimeImResponse>;

export type PublicRunImRuntimeInput = {
  socketPath: string;
  runId: string;
  selfEndpoint?: string;
  userEndpoint?: string;
  timeoutMs?: number;
  newRequestId?: () => string;
  requestHost?: RunImRuntimeRequestPort;
};

export type PublicRunImAckInput = PublicRunImRuntimeInput & {
  messageId: string;
};

export function resolveRunImEndpoints(input: {
  runId: string;
  selfEndpoint?: string;
  userEndpoint?: string;
}): { selfEndpoint: string; userEndpoint: string } {
  return {
    selfEndpoint: input.selfEndpoint ?? createRunImSelfEndpoint(input.runId),
    userEndpoint: input.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT,
  };
}

export async function ensureDefaultRunImBinding(
  input: PublicRunImRuntimeInput,
): Promise<PublicImRunBindingRecord> {
  const endpoints = resolveRunImEndpoints(input);
  const data = await requestRunImRuntimeData(input, {
    schemaVersion: 1,
    id: createRunImRequestId(input),
    type: "im.bind",
    runId: input.runId,
    self: endpoints.selfEndpoint,
    peer: endpoints.userEndpoint,
    kind: "a2user",
  });
  return requireRecordField<PublicImRunBindingRecord>(data, "binding");
}

export async function receivePublicRunIm(
  input: PublicRunImRuntimeInput,
): Promise<PublicImRunReceiveResult> {
  const data = await requestRunImRuntimeData(input, {
    schemaVersion: 1,
    id: createRunImRequestId(input),
    type: "im.run-recv",
    runId: input.runId,
  });
  return data as unknown as PublicImRunReceiveResult;
}

export function selectUserPeerMessages(
  result: PublicImRunReceiveResult,
  userEndpoint = DEFAULT_RUN_USER_ENDPOINT,
): PublicImRunReceiveMessage[] {
  return result.messages.filter((message) => message.binding.peer === userEndpoint);
}

export async function receivePublicRunUserMessages(
  input: PublicRunImRuntimeInput,
): Promise<PublicImRunReceiveMessage[]> {
  const result = await receivePublicRunIm(input);
  return selectUserPeerMessages(result, input.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT);
}

export async function ackPublicRunUserMessage(
  input: PublicRunImAckInput,
): Promise<void> {
  await requestRunImRuntimeData(input, {
    schemaVersion: 1,
    id: createRunImRequestId(input),
    type: "im.run-ack",
    runId: input.runId,
    peer: input.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT,
    messageId: input.messageId,
  });
}

async function requestRunImRuntimeData(
  input: PublicRunImRuntimeInput,
  request: RuntimeImRequest,
): Promise<Record<string, unknown>> {
  const requestHost = input.requestHost ?? requestRuntimeReplicaIm;
  const response = await requestHost({
    socketPath: input.socketPath,
    request,
    timeoutMs: input.timeoutMs ?? DEFAULT_RUN_IM_TIMEOUT_MS,
  });

  if (response.type === "im.error") {
    throw new Error(response.error.message);
  }
  if (response.type !== "im.result") {
    throw new Error(
      `Unexpected runtime IM response: ${String((response as { type?: unknown }).type)}`,
    );
  }
  if (!isRecord(response.data)) {
    throw new Error("Invalid runtime IM response: data must be an object");
  }
  return response.data;
}

function createRunImRequestId(input: PublicRunImRuntimeInput): string {
  return input.newRequestId?.() ?? `run-im-${randomUUID()}`;
}

function requireRecordField<T>(
  data: Record<string, unknown>,
  field: string,
): T {
  const value = data[field];
  if (!isRecord(value)) {
    throw new Error(`Invalid runtime IM response: ${field} must be an object`);
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
