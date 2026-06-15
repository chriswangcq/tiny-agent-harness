import { describe, expect, it } from "vitest";
import type { ImHostRequest, ImHostResponse } from "../src/im/index.js";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  ackPublicRunUserMessage,
  createRunImSelfEndpoint,
  ensureDefaultRunImBinding,
  receivePublicRunIm,
  receivePublicRunUserMessages,
  resolveRunImEndpoints,
  selectUserPeerMessages,
  type RunImHostRequest,
} from "../src/cli/run-im.js";

function hostResult(
  request: ImHostRequest,
  data: Record<string, unknown>,
): ImHostResponse {
  return {
    schemaVersion: 1,
    id: request.id,
    ok: true,
    type: "im.result",
    command: request.type as Exclude<ImHostRequest["type"], "im.shutdown">,
    data,
  };
}

describe("public run IM host client", () => {
  it("derives default run and user endpoints", () => {
    expect(createRunImSelfEndpoint("run-123")).toBe("run:run-123");
    expect(resolveRunImEndpoints({ runId: "run-123" })).toEqual({
      selfEndpoint: "run:run-123",
      userEndpoint: DEFAULT_RUN_USER_ENDPOINT,
    });
  });

  it("binds the default run a2user pair through im-host", async () => {
    const calls: RunImHostRequest[] = [];

    const binding = await ensureDefaultRunImBinding({
      socketPath: "/tmp/run/im-host.sock",
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
      socketPath: "/tmp/run/im-host.sock",
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

  it("receives all run messages through im-host and selects only user-peer messages", async () => {
    const calls: RunImHostRequest[] = [];
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
      socketPath: "/tmp/run/im-host.sock",
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
        socketPath: "/tmp/run/im-host.sock",
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

  it("acks only the default user peer channel through im-host", async () => {
    const calls: RunImHostRequest[] = [];

    await ackPublicRunUserMessage({
      socketPath: "/tmp/run/im-host.sock",
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

  it("surfaces im-host errors from run IM operations", async () => {
    await expect(
      receivePublicRunIm({
        socketPath: "/tmp/run/im-host.sock",
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
