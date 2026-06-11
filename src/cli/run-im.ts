import {
  DEFAULT_RUN_USER_ENDPOINT,
  createRunImSelfEndpoint,
  type PublicImRunBindingRecord,
  type PublicImRunReceiveMessage,
  type PublicImRunReceiveResult,
  type PublicImService,
} from "../im/index.js";

export { DEFAULT_RUN_USER_ENDPOINT, createRunImSelfEndpoint };

export type PublicRunImBindingInput = {
  service: PublicImService;
  stateRoot: string;
  runId: string;
  selfEndpoint?: string;
  userEndpoint?: string;
};

export type PublicRunImReceiveInput = {
  service: PublicImService;
  stateRoot: string;
  runId: string;
  userEndpoint?: string;
};

export type PublicRunImAckInput = PublicRunImReceiveInput & {
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
  input: PublicRunImBindingInput,
): Promise<PublicImRunBindingRecord> {
  const endpoints = resolveRunImEndpoints(input);
  return input.service.bindRun({
    stateRoot: input.stateRoot,
    runId: input.runId,
    self: endpoints.selfEndpoint,
    peer: endpoints.userEndpoint,
    kind: "a2user",
  });
}

export async function receivePublicRunIm(
  input: PublicRunImReceiveInput,
): Promise<PublicImRunReceiveResult> {
  return input.service.receiveForRun({
    stateRoot: input.stateRoot,
    runId: input.runId,
  });
}

export function selectUserPeerMessages(
  result: PublicImRunReceiveResult,
  userEndpoint = DEFAULT_RUN_USER_ENDPOINT,
): PublicImRunReceiveMessage[] {
  return result.messages.filter((message) => message.binding.peer === userEndpoint);
}

export async function receivePublicRunUserMessages(
  input: PublicRunImReceiveInput,
): Promise<PublicImRunReceiveMessage[]> {
  const result = await receivePublicRunIm(input);
  return selectUserPeerMessages(result, input.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT);
}

export async function ackPublicRunUserMessage(
  input: PublicRunImAckInput,
): Promise<void> {
  await input.service.ackRunChannel({
    stateRoot: input.stateRoot,
    runId: input.runId,
    peer: input.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT,
    messageId: input.messageId,
  });
}
