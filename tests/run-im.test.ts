import { describe, expect, it } from "vitest";
import type { RuntimeImRequest, RuntimeImResponse } from "../src/im/index.js";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  ackPublicRunUserMessage,
  createRunImSelfEndpoint,
  ensureDefaultRunImBinding,
  receivePublicRunIm,
  receivePublicRunUserMessages,
  resolveRunImEndpoints,
  selectUserPeerMessages,
  type RunImRuntimeRequest,
} from "../src/cli/run-im.js";

function hostResult(
  request: RuntimeImRequest,
  data: Record<string, unknown>,
): RuntimeImResponse {
  return {
    schemaVersion: 1,
    id: request.id,
    ok: true,
    type: "im.result",
    command: request.type,
    data,
  };
}

describe("public run IM runtime client", () => {
  const runtimeSocketPath = "/tmp/project/runtime.sock";
  it("derives default run and user endpoints", () => {
    expect(createRunImSelfEndpoint("run-123")).toBe("run:run-123");
    expect(resolveRunImEndpoints({ runId: "run-123" })).toEqual({
      selfEndpoint: "run:run-123",
      userEndpoint: DEFAULT_RUN_USER_ENDPOINT,
    });
  });

  it("binds the default run a2user pair through runtime replica", async () => {
    const calls: RunImRuntimeRequest[] = [];

    const binding = await ensureDefaultRunImBinding({
      socketPath: runtimeSocketPath,
      runId: "run-123",
      newRequestId: () => "bind-1",
      requestHost: async (call) => {
        calls.push(call);
        return hostResult(call.request, {
          binding: {
            runId: "run-123",
            self: "run:run-123",
            bindings: [
              {
                kind: "a2user",
                peer: "user:main",
              },
            ],
          },
        });
      },
    });

    expect(binding).toMatchObject({
      runId: "run-123",
      self: "run:run-123",
      bindings: [{ kind: "a2user", peer: "user:main" }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      socketPath: runtimeSocketPath,
      timeoutMs: 30_000,
    });
    expect(calls[0]!.request).toMatchObject({
      schemaVersion: 1,
      id: "bind-1",
      type: "im.bind",
      runId: "run-123",
      self: "run:run-123",
      peer: "user:main",
      kind: "a2user",
    });
  });

  it("receives all run messages through runtime replica and selects only user-peer messages", async () => {
    const calls: RunImRuntimeRequest[] = [];
    const userMessage = {
      id: "msg-user",
      text: "start task",
      binding: { peer: "user:main", kind: "a2user" },
    };
    const reviewerMessage = {
      id: "msg-reviewer",
      text: "review note",
      binding: { peer: "member:team-p6/reviewer-1", kind: "a2a" },
    };

    const all = await receivePublicRunIm({
      socketPath: runtimeSocketPath,
      runId: "run-123",
      newRequestId: () => "recv-1",
      requestHost: async (call) => {
        calls.push(call);
        return hostResult(call.request, {
          runId: "run-123",
          self: "run:run-123",
          count: 2,
          nextCursors: {},
          messages: [userMessage, reviewerMessage],
        });
      },
    });

    expect(all.messages.map((message) => message.text)).toEqual([
      "start task",
      "review note",
    ]);
    expect(selectUserPeerMessages(all).map((message) => message.id)).toEqual([
      "msg-user",
    ]);
    expect(calls[0]!.request).toMatchObject({
      id: "recv-1",
      type: "im.run-recv",
      runId: "run-123",
    });

    await expect(
      receivePublicRunUserMessages({
        socketPath: runtimeSocketPath,
        runId: "run-123",
        requestHost: async (call) =>
          hostResult(call.request, {
            runId: "run-123",
            self: "run:run-123",
            count: 2,
            nextCursors: {},
            messages: [userMessage, reviewerMessage],
          }),
      }),
    ).resolves.toMatchObject([{ id: "msg-user" }]);
  });

  it("acks only the default user peer channel through runtime replica", async () => {
    const calls: RunImRuntimeRequest[] = [];

    await ackPublicRunUserMessage({
      socketPath: runtimeSocketPath,
      runId: "run-123",
      messageId: "msg-user",
      newRequestId: () => "ack-1",
      requestHost: async (call) => {
        calls.push(call);
        return hostResult(call.request, {
          runId: "run-123",
          peer: "user:main",
          messageId: "msg-user",
        });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toMatchObject({
      schemaVersion: 1,
      id: "ack-1",
      type: "im.run-ack",
      runId: "run-123",
      peer: "user:main",
      messageId: "msg-user",
    });
  });

  it("surfaces runtime IM errors from run IM operations", async () => {
    await expect(
      receivePublicRunIm({
        socketPath: runtimeSocketPath,
        runId: "run-123",
        requestHost: async (call) => ({
          schemaVersion: 1,
          id: call.request.id,
          ok: false,
          type: "im.error",
          error: {
            code: "IM_ERROR",
            message: "binding missing",
          },
        }),
      }),
    ).rejects.toThrow("binding missing");
  });
});
